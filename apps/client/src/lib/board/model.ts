// Agent Board's UI state as one immutable record, written only through
// board/atoms.ts, which applies `normalize`. Contract: docs/CLIENT-STATE.md.
import type { RemoveTarget } from "@/lib/agentboard/actions";
import type { Selected, WindowsPayload } from "@/lib/agentboard/types";
import type { FocusLevel } from "@/lib/agentboard/windows";
import type { JumpRecall } from "@/lib/jump-recall";
import type { RailNode } from "@/lib/rail-nodes";

/** The nonce lets a re-request of the *same* session still fire. */
export type FocusTerminalRequest = { id: string; nonce: number };

export type BoardUi = Readonly<{
  /** The checkout on screen: its window strip, its panes, the queue's ring. */
  activeFolderDir: string | null;
  /** The session looked at, always inside `activeFolderDir`. */
  selected: Selected;
  /** The tile that last claimed a click — the sole driver of the violet ring. */
  focusedPaneId: string | null;
  focusLevel: FocusLevel;
  /** The tree's cursor, resolved against today's rows at read time (board/cursor.ts). */
  railCursor: RailNode | null;
  /** Session ids whose PTY is mounted (kept alive for scrollback). */
  open: readonly string[];
  /** Session id → its shell's checkout, before the snapshot knows the session. */
  cwds: Readonly<Record<string, string>>;
  /** The layout as edited here, `null` until then; read through `winsAtom`. */
  layout: WindowsPayload | null;
  /** Fold toggles made here, over the snapshot's saved `collapsed` map. */
  collapsedEdits: Readonly<Record<string, boolean>>;
  query: string;
  repoFilter: ReadonlySet<string>;
  idleRevealed: ReadonlySet<string>;
  unmanagedRevealed: ReadonlySet<string>;
  /** The checkout whose snooze menu is open — `z` opens it from the keyboard. */
  snoozeId: string | null;
  renaming: string | null;
  /** Live PTY titles (Claude emits `✳ <title>`), preferred over the backend label. */
  titles: Readonly<Record<string, string>>;
  /** Raised by BEL / OSC 9 since the user last looked at the session. */
  termAttention: Readonly<Record<string, true>>;
  jumpRecall: JumpRecall | null;
  focusTerminalRequest: FocusTerminalRequest | null;
  splitOpen: boolean;
  confirmRemove: RemoveTarget | null;
  /** The rail's new-task form, for one repo, and the base a fork set. */
  railTaskRepoKey: string | null;
  railTaskBase: string | undefined;
}>;

export const INITIAL_BOARD_UI: BoardUi = {
  activeFolderDir: null,
  selected: null,
  focusedPaneId: null,
  focusLevel: "rail",
  railCursor: null,
  open: [],
  cwds: {},
  layout: null,
  collapsedEdits: {},
  query: "",
  repoFilter: new Set(),
  idleRevealed: new Set(),
  unmanagedRevealed: new Set(),
  snoozeId: null,
  renaming: null,
  titles: {},
  termAttention: {},
  jumpRecall: null,
  focusTerminalRequest: null,
  splitOpen: false,
  confirmRemove: null,
  railTaskRepoKey: null,
  railTaskBase: undefined,
};

/** A transition: the next record from the current one. Must be pure. */
export type BoardTransition = (ui: BoardUi) => BoardUi;

/** The invariants every write is held to. Returns `ui` itself when it holds. */
export function normalize(ui: BoardUi): BoardUi {
  let next = ui;
  // The session looked at lives in the checkout on screen: a move to another
  // checkout, however it was made, leaves no selection behind in the old one.
  if (next.selected !== null && next.selected.folderDir !== next.activeFolderDir) {
    next = { ...next, selected: null };
  }
  // A session is mounted once.
  if (new Set(next.open).size !== next.open.length) {
    next = { ...next, open: [...new Set(next.open)] };
  }
  return next;
}

/** `value` or an updater of the previous value, as React's setters take. */
export type Update<T> = T | ((prev: T) => T);

export const resolveUpdate = <T>(u: Update<T>, prev: T): T =>
  typeof u === "function" ? (u as (p: T) => T)(prev) : u;

/** The transition that sets one field. A no-op keeps the record's identity. */
export const setField =
  <K extends keyof BoardUi>(key: K, u: Update<BoardUi[K]>): BoardTransition =>
  (ui) => {
    const value = resolveUpdate(u, ui[key]);
    return Object.is(value, ui[key]) ? ui : { ...ui, [key]: value };
  };
