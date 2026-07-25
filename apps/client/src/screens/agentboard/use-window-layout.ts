import { useEffect, useRef, useState } from "react";
import {
  changedFolderDirs,
  dropPane,
  exitPaneId,
  hydrateWins,
  normalizeWins,
  nextWindowId,
  placePane,
  pruneWins,
  replacePane,
  type RepoData,
  type StatePayload,
  type WindowsPayload,
} from "@/lib/agentboard";
import { invoke } from "@/lib/tauri";

export type WindowLayout = {
  /** The whole persisted layout — null until the first backend payload lands. */
  wins: WindowsPayload | null;
  /** Apply `fn` to the layout and schedule a debounced save, naming the folder
   * dirs it touched (the backend merges per folder — see `WindowsStore::save`). */
  updateWins: (folderDirs: string[], fn: (w: WindowsPayload) => WindowsPayload) => void;
  /** Add a pane (session, diff, files, preview) to its folder's focused window. */
  addPaneToActive: (folderDir: string, paneId: string) => void;
  /** Drop one pane from whichever window holds it. */
  removePane: (paneId: string) => void;
  /** Swap a pane's occupant while it keeps its place in the tiling — a crashed
   * session handing its tile to its tombstone. */
  replacePaneInPlace: (from: string, to: string) => void;
  /** Drop whichever pane a session occupies — its terminal or its tombstone. */
  removeSessionPane: (sessionId: string) => void;
};

/**
 * Window layout (Tier 5): frontend-owned, hydrated once from the backend
 * payload, saved back debounced. After hydration this local copy is the live
 * truth and only ever flows outward.
 *
 * The layout is also reconciled against reality on every change — sessions and
 * folders vanish out from under the persisted blob (closed by another task's
 * app instance, a repo removed with non-live session records, a crash before
 * the debounced save), leaving ghost pane ids holding a tile with nothing to
 * render in it. See the prune effect for why locally-mounted terminals count
 * as valid before the backend catches up.
 */
export function useWindowLayout(args: {
  state: StatePayload;
  repos: RepoData[];
  /** Session ids whose PTY is mounted locally, and their cwds — both carve-outs
   * in the prune below, so a just-created session's pane never loses the race. */
  open: string[];
  cwds: React.RefObject<Record<string, string>>;
}): WindowLayout {
  const { state, repos, open, cwds } = args;
  const [wins, setWins] = useState<WindowsPayload | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Folder dirs actually mutated since the last flush — the backend merges
  // by folder dir on save, so it needs to know which ones we touched (a
  // never-hydrated-vs-explicitly-emptied folder look identical in the blob
  // alone; see `WindowsStore::save`'s doc comment).
  const dirtyWinFolders = useRef<Set<string>>(new Set());

  function scheduleSave(next: WindowsPayload, folderDirs: string[]) {
    for (const dir of folderDirs) dirtyWinFolders.current.add(dir);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const touchedFolders = [...dirtyWinFolders.current];
      dirtyWinFolders.current = new Set();
      void invoke("ab_save_windows", { payload: next, touchedFolders });
    }, 400);
  }

  function updateWins(folderDirs: string[], fn: (w: WindowsPayload) => WindowsPayload) {
    setWins((prev) => {
      const next = normalizeWins(fn(prev ?? { windows: [], activeWindows: {} }));
      scheduleSave(next, folderDirs);
      return next;
    });
  }

  useEffect(() => {
    // Hydrate from the first real payload (mock or ab_get_state); after that
    // the local copy is the live truth and only flows outward. `hydrateWins`
    // is the parse boundary: paneless windows restored from old blobs are
    // residue (the empty-pane state is unrepresentable now) — swept there,
    // and the sweep is persisted if it changed anything.
    if (wins !== null || state.ts === 0) return;
    const hydrated = hydrateWins(state.windows);
    setWins(hydrated);
    const touched = changedFolderDirs(state.windows, hydrated);
    if (touched.length > 0) scheduleSave(hydrated, touched);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scheduleSave is stable within a render; the reactive inputs are all listed
  }, [wins, state.ts, state.windows]);

  // Locally-mounted terminals (`open`) count as valid even before the
  // backend's state event catches up, so a just-created session's pane never
  // loses the race to this prune — and so do their folders (via the cwd
  // recorded at mount): a just-created task's window is keyed on a folder dir
  // the backend hasn't broadcast yet, and without that carve-out this prune
  // ate the whole window (and persisted the loss), leaving the new task's main
  // area empty until re-clicked.
  useEffect(() => {
    if (!wins) return;
    const validSessions = new Set(open);
    const validFolders = new Set<string>();
    for (const id of open) {
      const dir = cwds.current[id];
      if (dir) validFolders.add(dir);
    }
    for (const r of repos)
      for (const f of r.folders) {
        validFolders.add(f.dir);
        for (const s of f.sessions) validSessions.add(s.id);
      }
    const next = pruneWins(wins, validSessions, validFolders);
    if (next !== wins) {
      updateWins(changedFolderDirs(wins, next), (cur) =>
        pruneWins(cur, validSessions, validFolders),
      );
    }
    // updateWins is stable within a render pass; wins/repos/open are the inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- updateWins is stable within a render; the reactive inputs are all listed
  }, [wins, repos, open]);

  // Add a pane (session or diff) to its own folder's focused window — the
  // placement rules live in the pure `placePane` reducer (lib/agentboard.ts).
  // A session reclaims its own tombstone first: the crashed pane is that
  // session's task, so reopening fills it in place instead of `placePane`
  // appending a second pane beside the corpse.
  function addPaneToActive(folderDir: string, paneId: string) {
    updateWins([folderDir], (w) =>
      placePane(replacePane(w, exitPaneId(paneId), paneId), folderDir, paneId, nextWindowId),
    );
  }

  function removePane(paneId: string) {
    // A pane lives in exactly one folder's window; find it before mutating
    // so we know which single folder to mark touched.
    const folderDir = wins?.windows.find((win) => win.panes.includes(paneId))?.folderDir;
    updateWins(folderDir ? [folderDir] : [], (w) => dropPane(w, paneId));
  }

  function replacePaneInPlace(from: string, to: string) {
    const folderDir = wins?.windows.find((win) => win.panes.includes(from))?.folderDir;
    updateWins(folderDir ? [folderDir] : [], (w) => replacePane(w, from, to));
  }

  /** Remove whichever pane a session currently occupies — its terminal, or the
   * tombstone that replaced it when the shell crashed. Every session-keyed
   * removal (close, worktree delete) goes through here, so none of them has
   * to know which of the two it's looking at. */
  function removeSessionPane(sessionId: string) {
    const ids = [sessionId, exitPaneId(sessionId)];
    const folderDir = wins?.windows.find((win) =>
      ids.some((id) => win.panes.includes(id)),
    )?.folderDir;
    updateWins(folderDir ? [folderDir] : [], (w) => ids.reduce((acc, id) => dropPane(acc, id), w));
  }

  return { wins, updateWins, addPaneToActive, removePane, replacePaneInPlace, removeSessionPane };
}
