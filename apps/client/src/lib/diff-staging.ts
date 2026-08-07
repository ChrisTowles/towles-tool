/** Pure text/state logic behind hunk staging — the Monaco-free part, so it can
 * be unit-tested. The gutter actions (components/diff-gutter-actions.ts) call
 * `revertLineRange` to synthesize "index minus this hunk" when unstaging. */

/** Monaco's `LineRange`: 1-based start, exclusive end. Empty when equal. */
export type LineRangeLite = { startLineNumber: number; endLineNumberExclusive: number };

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
