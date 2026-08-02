/**
 * Pure helpers for the canvas terminal's mouse-selection and right-click
 * context menu. No DOM, no Tauri — unit-tested alongside `term-protocol`.
 */

/** A selection gesture understood by the `term_select` command. */
export type SelectionKind = "drag" | "word" | "line" | "all" | "clear";

/**
 * Capped at three deliberately: `detail` keeps climbing across a sustained
 * click sequence, and re-selecting the line re-took the clipboard each press.
 */
export function selectionKindForDetail(detail: number): "word" | "line" | "drag" {
  if (detail === 2) return "word";
  if (detail === 3) return "line";
  return "drag";
}

/**
 * A word/line gesture as a comparable value, over the *absolute* scrollback
 * cell so it survives scrolling. A drag needs none — its range is always new.
 */
export function selectionGestureKey(kind: "word" | "line", col: number, row: number): string {
  return kind === "line" ? `line:${row}` : `word:${col}:${row}`;
}

/**
 * The two keys guard a *deliberate* repeat — re-selecting a word or line you
 * already took — from re-taking the clipboard; a new target still copies.
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
