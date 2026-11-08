// The one owner of Agent Board's UI state. Contract: docs/CLIENT-STATE.md.
import { Schema } from "effect";
import * as Atom from "effect/reactivity/Atom";
import { persistedAtom } from "@/lib/atoms/persisted";
import { read, write } from "@/lib/atoms/registry";
import { LANES } from "@/lib/queue";
import type { Lane } from "@/lib/schemas/queue";
import {
  INITIAL_BOARD_UI,
  normalize,
  resolveUpdate,
  setField,
  type BoardTransition,
  type BoardUi,
  type Update,
} from "./model";

const uiState = Atom.make<BoardUi>(INITIAL_BOARD_UI).pipe(Atom.keepAlive);

/** Read it whole or by field; write it only with a transition. The writer is
 * the single place the record changes, and it applies `normalize`. */
const boardUiAtom = Atom.writable(
  (get) => get(uiState),
  (ctx, t: BoardTransition) => {
    const prev = ctx.get(uiState);
    const next = normalize(t(prev));
    if (next !== prev) ctx.set(uiState, next);
  },
).pipe(Atom.keepAlive);

export const dispatchBoard = (t: BoardTransition): void => write(boardUiAtom, t);

/** The whole record as of now. */
export const readBoard = (): BoardUi => read(boardUiAtom);

const fieldAtoms = new Map<keyof BoardUi, Atom.Atom<unknown>>();

/** One field as an atom: a reader wakes only when that field changes. */
export function boardField<K extends keyof BoardUi>(key: K): Atom.Atom<BoardUi[K]> {
  let atom = fieldAtoms.get(key);
  if (!atom) {
    atom = Atom.make((get) => get(boardUiAtom)[key]).pipe(Atom.keepAlive);
    fieldAtoms.set(key, atom);
  }
  return atom as Atom.Atom<BoardUi[K]>;
}

/** A setter for one field, React-setter shaped, with a fixed identity. */
const fieldSetter =
  <K extends keyof BoardUi>(key: K): ((u: Update<BoardUi[K]>) => void) =>
  (u) =>
    dispatchBoard(setField(key, u));

/** A field as a read-only ref that always reads the record now — for helpers
 * written against `ref.current`. It is a view, never a copy. */
const fieldRef = <K extends keyof BoardUi>(key: K): { readonly current: BoardUi[K] } => ({
  get current() {
    return read(boardUiAtom)[key];
  },
});

export const setSelected = fieldSetter("selected");
export const setActiveFolderDir = fieldSetter("activeFolderDir");
export const setFocusedPaneId = fieldSetter("focusedPaneId");
export const setFocusLevel = fieldSetter("focusLevel");
export const setRailCursor = fieldSetter("railCursor");
export const setOpen = fieldSetter("open");
export const setQuery = fieldSetter("query");
export const setRepoFilter = fieldSetter("repoFilter");
export const setIdleRevealed = fieldSetter("idleRevealed");
export const setUnmanagedRevealed = fieldSetter("unmanagedRevealed");
export const setSnoozeId = fieldSetter("snoozeId");
export const setRenaming = fieldSetter("renaming");
export const setTitles = fieldSetter("titles");
export const setTermAttention = fieldSetter("termAttention");
export const setJumpRecall = fieldSetter("jumpRecall");
export const setFocusTerminalRequest = fieldSetter("focusTerminalRequest");
export const setSplitOpen = fieldSetter("splitOpen");
export const setConfirmRemove = fieldSetter("confirmRemove");
export const setRailTaskRepoKey = fieldSetter("railTaskRepoKey");
export const setRailTaskBase = fieldSetter("railTaskBase");

/** Lanes folded shut on the queue, remembered across launches. */
const FOLDED_BY_DEFAULT: readonly Lane[] = ["parked", "no_shell"];
const foldedLaneList = persistedAtom(
  "tt-queue-folded-lanes",
  // Strings, not lanes: a lane since renamed drops out rather than voiding the rest.
  Schema.Array(Schema.String),
  FOLDED_BY_DEFAULT,
);
export const foldedLanesAtom: Atom.Atom<ReadonlySet<Lane>> = Atom.make(
  (get) => new Set(LANES.filter((l) => get(foldedLaneList).includes(l))),
).pipe(Atom.keepAlive);

export function setFoldedLanes(u: Update<ReadonlySet<Lane>>): void {
  const prev = read(foldedLanesAtom);
  const next = resolveUpdate(u, prev);
  if (next !== prev)
    write(
      foldedLaneList,
      LANES.filter((l) => next.has(l)),
    );
}

/** The selected session id and the checkout on screen, as live views. */
export const selectedIdRef: { readonly current: string | null } = {
  get current() {
    return read(boardUiAtom).selected?.sessionId ?? null;
  },
};
export const activeFolderDirRef = fieldRef("activeFolderDir");

/** Session id → the checkout its shell was started in, as a live view. */
export const cwdsRef = fieldRef("cwds");

/** A counter, not state: each jump card takes the next number so a repeat of
 * the same jump still replays its card. */
export const jumpNonce: { current: number } = { current: 0 };

/** The repo the last rail task was made in — the form's default next time. */
export const lastTaskRepoAtom = persistedAtom(
  "tt-agentboard-last-task-repo",
  Schema.NullOr(Schema.String),
  null,
);
