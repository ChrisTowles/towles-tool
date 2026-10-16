import type { Dispatch, RefObject, SetStateAction } from "react";
import type { RemoveTarget } from "@/lib/agentboard/actions";
import { liveSessions } from "@/lib/agentboard/session";
import type { RepoData, Selected, SessionData, WindowsPayload } from "@/lib/agentboard/types";
import { paneCloseTarget, successorPane } from "@/lib/agentboard/windows";
import { untrackRepo } from "@/lib/repo-actions";
import { invoke } from "@/lib/tauri";
import { exitIsCrash, exitLabel, type TermExit } from "@/lib/term-protocol";
import { toast } from "@/lib/toast";

/** Ending sessions and panes: the shell going away, and focus finding somewhere
 * else to land. Rebuilt every render, like the closures it replaces. */
export function sessionLifecycle(a: {
  repos: RepoData[];
  wins: WindowsPayload | null;
  focusedPaneId: string | null;
  selected: Selected;
  activePanes: readonly string[];
  sessionById: Map<string, SessionData>;
  expectedKills: RefObject<Set<string>>;
  labelFor: (s: SessionData) => string;
  selectSession: (folderDir: string, sessionId: string) => void;
  removePane: (paneId: string) => void;
  setFocusedPaneId: Dispatch<SetStateAction<string | null>>;
  setOpen: Dispatch<SetStateAction<string[]>>;
  setSelected: Dispatch<SetStateAction<Selected>>;
  setConfirmRemove: Dispatch<SetStateAction<RemoveTarget | null>>;
  setRenaming: Dispatch<SetStateAction<string | null>>;
}) {
  // Closing the focused pane hands focus to its neighbor (and `selected` moves
  // too, for a live one), so a repeated ab-close-pane chord keeps eating panes.
  // Closing an unfocused pane moves nothing.
  function shiftFocusFrom(...closedIds: string[]) {
    const { wins, focusedPaneId, selected } = a;
    const lost = closedIds.some((id) => id === focusedPaneId || id === selected?.sessionId);
    if (!lost) return;
    const next = wins
      ? (closedIds.map((id) => successorPane(wins, id)).find((n) => n !== null) ?? null)
      : null;
    if (next === null) {
      a.setFocusedPaneId(null);
      return;
    }
    const dir = wins?.windows.find((w) => w.panes.includes(next))?.folderDir;
    if (dir && a.sessionById.has(next)) a.selectSession(dir, next);
    else a.setFocusedPaneId(next);
  }

  async function closeSession(sessionId: string) {
    await invoke("ab_close_session", { id: sessionId });
    shiftFocusFrom(sessionId);
    a.setOpen((prev) => prev.filter((id) => id !== sessionId));
    a.setSelected((cur) => (cur?.sessionId === sessionId ? null : cur));
    a.removePane(sessionId);
  }

  /** A view pane's ✕ / close shortcut: focus hand-off, then the layout drop. */
  function closePane(paneId: string) {
    shiftFocusFrom(paneId);
    a.removePane(paneId);
  }

  /** ab-close-pane (⌘⇧W) and the strip's Close: the focused tile goes, whichever
   * kind it is. `paneCloseTarget` decides. */
  function closeFocusedPane() {
    const target = paneCloseTarget(a.focusedPaneId, a.activePanes);
    if (!target) return;
    if (target.kind === "session") void closeSession(target.sessionId);
    else closePane(target.paneId);
  }

  /** A shell exited on its own. Its pane goes with it, and the backend drops
   * the session — a crash leaves only the toast saying how it died. */
  function handleExit(sessionId: string, exit: TermExit) {
    a.setOpen((prev) => prev.filter((id) => id !== sessionId));
    a.setSelected((cur) => (cur?.sessionId === sessionId ? null : cur));
    closePane(sessionId);
    const expected = a.expectedKills.current.delete(sessionId);
    if (expected || !exitIsCrash(exit.code, exit.signal)) return;
    const s = a.sessionById.get(sessionId);
    toast.error(`${s ? a.labelFor(s) : "shell"} ${exitLabel(exit.code, exit.signal)}`);
  }

  // Kill live sessions first — killing a PTY is client-mediated — then drop the
  // checkout(s) from the watched list.
  async function performRemove(target: RemoveTarget) {
    // Closed here rather than in `untrackRepo` because `closeSession` also clears
    // this screen's local pane state; the seam is handed an empty id list.
    for (const id of target.sessionIds) await closeSession(id);
    for (const dir of target.dirs) await untrackRepo(dir, target.label, [], "agentboard");
  }

  function requestRemoveRepo(dirs: string[], label: string) {
    const folders = a.repos.flatMap((r) => r.folders).filter((f) => dirs.includes(f.dir));
    const sessionIds = folders.flatMap((f) => liveSessions(f).map((s) => s.id));
    const target: RemoveTarget = { label, dirs, sessionIds };
    if (sessionIds.length === 0) {
      void performRemove(target);
      return;
    }
    a.setConfirmRemove(target);
  }

  async function commitRename(sessionId: string, name: string) {
    a.setRenaming(null);
    const trimmed = name.trim();
    if (trimmed) await invoke("ab_rename_session", { id: sessionId, name: trimmed });
  }

  return {
    closeSession,
    closePane,
    closeFocusedPane,
    handleExit,
    performRemove,
    requestRemoveRepo,
    commitRename,
  };
}
