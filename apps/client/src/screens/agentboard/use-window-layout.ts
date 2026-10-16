import { useEffect, useRef, useState } from "react";
import type { RepoData, StatePayload, WindowsPayload } from "@/lib/agentboard/types";
import {
  changedFolderDirs,
  dropPane,
  hydrateWins,
  normalizeWins,
  nextWindowId,
  placePane,
  pruneWins,
} from "@/lib/agentboard/windows";
import { invoke } from "@/lib/tauri";

export type WindowLayout = {
  wins: WindowsPayload | null;
  updateWins: (folderDirs: string[], fn: (w: WindowsPayload) => WindowsPayload) => void;
  addPaneToActive: (folderDir: string, paneId: string) => void;
  removePane: (paneId: string) => void;
};

// Hydrated once from the backend, then frontend-owned and saved back debounced.
// Reconciled on every change: sessions and folders vanish out from under the
// persisted blob, leaving ghost pane ids holding a tile with nothing to render.
export function useWindowLayout(args: {
  state: StatePayload;
  repos: RepoData[];
  open: string[];
  cwds: React.RefObject<Record<string, string>>;
}): WindowLayout {
  const { state, repos, open, cwds } = args;
  const [wins, setWins] = useState<WindowsPayload | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The backend merges by folder dir on save, so it needs which ones we touched:
  // never-hydrated and explicitly-emptied are identical in the blob alone.
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
    if (wins !== null || state.ts === 0) return;
    const hydrated = hydrateWins(state.windows);
    setWins(hydrated);
    const touched = changedFolderDirs(state.windows, hydrated);
    if (touched.length > 0) scheduleSave(hydrated, touched);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scheduleSave is stable within a render; the reactive inputs are all listed
  }, [wins, state.ts, state.windows]);

  // Locally-mounted terminals (`open`) and their cwds count as valid before the
  // backend's state event catches up, or this prune eats — and persists the
  // loss of — a just-created task's window, keyed on a dir not yet broadcast.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- updateWins is stable within a render; the reactive inputs are all listed
  }, [wins, repos, open]);

  function addPaneToActive(folderDir: string, paneId: string) {
    updateWins([folderDir], (w) => placePane(w, folderDir, paneId, nextWindowId));
  }

  function removePane(paneId: string) {
    const folderDir = wins?.windows.find((win) => win.panes.includes(paneId))?.folderDir;
    updateWins(folderDir ? [folderDir] : [], (w) => dropPane(w, paneId));
  }

  return { wins, updateWins, addPaneToActive, removePane };
}
