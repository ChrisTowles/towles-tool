// The ways Agent Board arrives at a checkout or session. Each is ONE transition
// on the UI record, so a click lands as one write and `normalize` sees the
// finished state, never a half-moved one.
import { read } from "@/lib/atoms/registry";
import { fire, invoke } from "@/lib/tauri";
import { dispatchBoard } from "./atoms";
import { addPaneToActive } from "./commands";
import { lookupsAtom, railTreeAtom } from "./derive";
import type { BoardTransition, BoardUi } from "./model";

/** `m` unless it holds `key`, in which case a copy without it. */
export function withoutKey<T>(m: Readonly<Record<string, T>>, key: string): Record<string, T> {
  if (!m[key]) return m;
  const { [key]: _, ...rest } = m;
  return rest;
}

/** Looking at the rail entry clears its agents' `unseen` pulse. */
function ackFolder(folderDir: string): void {
  const name = read(lookupsAtom).folderNameByDir.get(folderDir);
  if (name) fire(invoke("ab_mark_seen", { name }));
}

/** Reaching a checkout any way at all hands the tree's cursor to it — its
 * session's row when there is one. The queue's ring follows `activeFolderDir`. */
const cursorTo =
  (folderDir: string, sessionId?: string): BoardTransition =>
  (ui) => {
    const nodes = read(railTreeAtom);
    const node =
      (sessionId === undefined ? undefined : nodes.find((n) => n.sessionId === sessionId)) ??
      nodes.find((n) => n.kind !== "session" && n.dir === folderDir);
    return node ? { ...ui, railCursor: node } : ui;
  };

/** Pure: put `folderDir` on screen at rail level. */
export const toFolder =
  (folderDir: string): BoardTransition =>
  (ui) => ({ ...cursorTo(folderDir)(ui), activeFolderDir: folderDir, focusLevel: "rail" });

/** Pure: mount a session's PTY and place its pane, without moving selection. */
export const mounted =
  (folderDir: string, sessionId: string): BoardTransition =>
  (ui): BoardUi => ({
    ...ui,
    cwds: ui.cwds[sessionId] === folderDir ? ui.cwds : { ...ui.cwds, [sessionId]: folderDir },
    open: ui.open.includes(sessionId) ? ui.open : [...ui.open, sessionId],
  });

/** Pure: look at a session — mounted, selected, its checkout on screen. */
export const toSession =
  (folderDir: string, sessionId: string): BoardTransition =>
  (ui) => ({
    ...cursorTo(folderDir, sessionId)(mounted(folderDir, sessionId)(ui)),
    jumpRecall: null,
    activeFolderDir: folderDir,
    selected: { folderDir, sessionId },
    focusedPaneId: sessionId,
    // Rail-level by default; a pane focus overrides it in its own write.
    focusLevel: "rail",
    termAttention: withoutKey(ui.termAttention, sessionId),
  });

function selectFolder(folderDir: string): void {
  dispatchBoard(toFolder(folderDir));
  ackFolder(folderDir);
}

/** For sessions created in the background: leaves the selection where it is. */
function mountSession(folderDir: string, sessionId: string): void {
  dispatchBoard(mounted(folderDir, sessionId));
  addPaneToActive(folderDir, sessionId);
}

function selectSession(folderDir: string, sessionId: string): void {
  dispatchBoard(toSession(folderDir, sessionId));
  addPaneToActive(folderDir, sessionId);
  ackFolder(folderDir);
}

export const SELECTION = { ackFolder, selectFolder, mountSession, selectSession };
