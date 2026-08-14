/** Pure text/state logic behind hunk staging — the Monaco-free part, so it can
 * be unit-tested. The gutter actions (components/diff-gutter-actions.ts) call
 * `revertLineRange` to synthesize "index minus this hunk" when unstaging. */

/** Monaco's `LineRange`: 1-based start, exclusive end. Empty when equal. */
export type LineRangeLite = { startLineNumber: number; endLineNumberExclusive: number };

/** Monaco's `Range`: 1-based lines and columns, end-exclusive column. */
export type RangeLite = {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};

/** One char-precise original↔modified correspondence (Monaco's `RangeMapping`). */
export type RangeMappingLite = { originalRange: RangeLite; modifiedRange: RangeLite };

/** Split into lines that keep their own terminators, so joins can't invent or
 * drop a trailing newline — the classic hunk-apply bug (vscode#59670). */
function lineSpans(text: string): string[] {
  if (text === "") return [];
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** `modifiedText` with one mapping's lines put back to the original's — how a
 * hunk is reverted: replace the modified line range with the original range's
 * text. With (original=HEAD, modified=index) this is "unstage this hunk". */
export function revertLineRange(
  originalText: string,
  modifiedText: string,
  original: LineRangeLite,
  modified: LineRangeLite,
): string {
  const originalLines = lineSpans(originalText);
  const modifiedLines = lineSpans(modifiedText);
  const replacement = originalLines.slice(
    original.startLineNumber - 1,
    original.endLineNumberExclusive - 1,
  );
  modifiedLines.splice(
    modified.startLineNumber - 1,
    modified.endLineNumberExclusive - modified.startLineNumber,
    ...replacement,
  );
  return modifiedLines.join("");
}

/** Offsets where each 1-based line begins. */
function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

/** (line, column) → char offset, clamped: a range may end one past EOF. */
function offsetOf(starts: number[], length: number, line: number, column: number): number {
  if (line - 1 >= starts.length) return length;
  return Math.min(length, starts[line - 1] + column - 1);
}

/** `modifiedText` with each mapping's exact character span put back to the
 * original's — the precise inverse of the gutter's `computeStagedValue`. The
 * selection toolbar's mappings carry only the *selected* changes, so unstaging
 * a selection must not touch the span between them (which the outer line-range
 * hull would). Mappings must not overlap; Monaco's never do. */
export function revertRangeMappings(
  originalText: string,
  modifiedText: string,
  mappings: RangeMappingLite[],
): string {
  const originalStarts = lineStartOffsets(originalText);
  const modifiedStarts = lineStartOffsets(modifiedText);
  // Back to front, so each splice leaves every earlier offset intact.
  const sorted = mappings.toSorted(
    (a, b) =>
      b.modifiedRange.startLineNumber - a.modifiedRange.startLineNumber ||
      b.modifiedRange.startColumn - a.modifiedRange.startColumn,
  );
  let out = modifiedText;
  for (const m of sorted) {
    const start = offsetOf(
      modifiedStarts,
      modifiedText.length,
      m.modifiedRange.startLineNumber,
      m.modifiedRange.startColumn,
    );
    const end = offsetOf(
      modifiedStarts,
      modifiedText.length,
      m.modifiedRange.endLineNumber,
      m.modifiedRange.endColumn,
    );
    const originalStart = offsetOf(
      originalStarts,
      originalText.length,
      m.originalRange.startLineNumber,
      m.originalRange.startColumn,
    );
    const originalEnd = offsetOf(
      originalStarts,
      originalText.length,
      m.originalRange.endLineNumber,
      m.originalRange.endColumn,
    );
    out = out.slice(0, start) + originalText.slice(originalStart, originalEnd) + out.slice(end);
  }
  return out;
}

/** The tree checkbox's three states in a staging mode. */
export function stageCheckState(f: {
  staged: boolean;
  unstaged: boolean;
}): boolean | "indeterminate" {
  if (f.staged && f.unstaged) return "indeterminate";
  return f.staged;
}

/** What clicking a staging checkbox should do: a fully staged file unstages,
 * anything else (unstaged or partial) stages the rest. */
export function stageToggleAction(f: { staged: boolean; unstaged: boolean }): "stage" | "unstage" {
  return f.staged && !f.unstaged ? "unstage" : "stage";
}

/** Folder checkbox over `files`: checked when every file is fully staged,
 * indeterminate when anything is, unchecked otherwise. */
export function folderStageState(
  files: Array<{ staged: boolean; unstaged: boolean }>,
): boolean | "indeterminate" {
  if (files.length === 0) return false;
  if (files.every((f) => f.staged && !f.unstaged)) return true;
  return files.some((f) => f.staged) ? "indeterminate" : false;
}
