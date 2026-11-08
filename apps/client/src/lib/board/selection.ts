// The ways Agent Board arrives at a checkout or session. Each is ONE transition
// on the UI record, so a click lands as one write and `normalize` sees the
// finished state, never a half-moved one.
import { Result, Schema } from "effect";
import { feed, onEvent } from "@/lib/atoms/feed";
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

/** Pure: a checkout removed, by this screen or anyone else. Its sessions are
 * unmounted (a mounted id would keep its window alive), and if it was on screen
 * the view lands on its repo's main checkout, else the standby screen. */
const checkoutClosed =
  (dir: string, owner: string | null, sessionIds: readonly string[]): BoardTransition =>
  (ui) => {
    const gone = new Set(sessionIds);
    const next: BoardUi = {
      ...ui,
      open: ui.open.filter((id) => !gone.has(id)),
      cwds: Object.fromEntries(Object.entries(ui.cwds).filter(([id]) => !gone.has(id))),
      selected: ui.selected && gone.has(ui.selected.sessionId) ? null : ui.selected,
      focusedPaneId: ui.focusedPaneId && gone.has(ui.focusedPaneId) ? null : ui.focusedPaneId,
    };
    if (ui.activeFolderDir !== dir) return next;
    return owner ? toFolder(owner)(next) : { ...next, activeFolderDir: null, focusLevel: "rail" };
  };

const decodeCheckoutClosed = Schema.decodeUnknownResult(
  Schema.Struct({
    dir: Schema.String,
    owner: Schema.NullOr(Schema.String),
    sessionIds: Schema.Array(Schema.String),
  }),
);

// A killed PTY reports no exit, so the removal says which panes went with it.
feed("checkout-closed", () =>
  onEvent("agentboard://checkout-closed", (p) => {
    const c = decodeCheckoutClosed(p);
    if (Result.isFailure(c)) {
      console.error("agentboard://checkout-closed: unexpected payload", c.failure);
      return;
    }
    closeCheckout(c.success.dir, c.success.owner, c.success.sessionIds);
  }),
);

function closeCheckout(dir: string, owner: string | null, sessionIds: readonly string[]): void {
  dispatchBoard(checkoutClosed(dir, owner, sessionIds));
}

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

export const SELECTION = { ackFolder, closeCheckout, selectFolder, mountSession, selectSession };
