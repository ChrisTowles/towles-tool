/**
 * Pure helpers for the canvas terminal's mouse-selection and right-click
 * context menu. No DOM, no Tauri — unit-tested alongside `term-protocol`.
 */

/** A selection gesture understood by the `term_select` command. */
export type SelectionKind = "drag" | "word" | "line" | "all" | "clear";

/**
 * The selection kind a left mouse-down implies from its click count: a
 * double-click selects the word, a triple (or higher) click the line, and a
 * single click begins a drag range.
 */
export function selectionKindForDetail(detail: number): "word" | "line" | "drag" {
  if (detail === 2) return "word";
  if (detail >= 3) return "line";
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
 * That last clause is why this takes two keys. `selectionKindForDetail` maps
 * *every* click past the second to `line` (`detail >= 3`), and the word/line
 * branch copies on `mousedown` — so ordinary clicking around inside a pane
 * re-took the system clipboard on every press, once a second or faster, each
 * time with whatever line sat under the cursor. Re-copying a selection the
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
