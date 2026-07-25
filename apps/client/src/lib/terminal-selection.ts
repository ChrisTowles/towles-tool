/**
 * Pure helpers for the canvas terminal's mouse-selection and right-click
 * context menu. No DOM, no Tauri — unit-tested alongside `term-protocol`.
 */

/** A selection gesture understood by the `term_select` command. */
export type SelectionKind = "drag" | "word" | "line" | "all" | "clear";

/**
 * The selection kind a left mouse-down implies from its click count: a
 * double-click selects the word, a triple click the line, and anything else —
 * a single click, or a fourth and beyond — begins a drag range.
 *
 * The cycle is deliberately **capped at three**. `detail` keeps climbing for
 * as long as the presses stay inside the browser's multi-click interval, so
 * an uncapped `detail >= 3` meant every press in a sustained click sequence
 * re-selected a line — and, under copy-on-select, re-took the system
 * clipboard with it. Past a triple-click the user is just clicking, so it
 * reads as a plain click (which clears the selection) rather than a fourth
 * selection gesture.
 */
export function selectionKindForDetail(detail: number): "word" | "line" | "drag" {
  if (detail === 2) return "word";
  if (detail === 3) return "line";
  return "drag";
}

/**
 * What a word/line gesture selected, as a value two gestures can be compared
 * by: the kind plus the *absolute* scrollback cell it landed on (row 0 = the
 * oldest scrollback row, so the key survives scrolling). A line ignores the
 * column, because every click on that row selects the same line.
 *
 * A drag has no key — its range is the anchor/head pair the pointer just
 * traced, so it is new by construction.
 */
export function selectionGestureKey(kind: "word" | "line", col: number, row: number): string {
  return kind === "line" ? `line:${row}` : `word:${col}:${row}`;
}

/**
 * Whether a completed selection gesture should copy to the clipboard under the
 * copy-on-select preference: the preference is on, the gesture produced a
 * selection (never a `clear`), and it did not select what the last auto-copy
 * already took.
 *
 * That last clause is why this takes two keys, and it is a separate guard
 * from the click-cycle cap in `selectionKindForDetail`. The cap stops a
 * *sustained* click sequence from selecting a line over and over; this stops
 * a *deliberate* repeat — double-clicking the same word again, or clicking
 * back onto a line you already took — from re-taking the clipboard, since
 * the word/line branch copies on `mousedown`. Re-copying a selection the
 * user never changed is the bug; a genuinely new target still copies.
 */
export function shouldCopyOnSelect(
  enabled: boolean,
  kind: SelectionKind,
  gesture: string | null,
  lastGesture: string | null,
): boolean {
  if (!enabled || kind === "clear") return false;
  return gesture === null || gesture !== lastGesture;
}

/**
 * Whether any row carries a selection range. Drives the context menu's Copy
 * item, which is enabled only when there is something to copy.
 */
export function rowsHaveSelection(lines: { sel?: [number, number] }[]): boolean {
  return lines.some((l) => l.sel !== undefined);
}
