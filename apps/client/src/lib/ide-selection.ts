/** Monaco selection → Claude IDE-bridge conversions. The two wire shapes disagree
 * on purpose: streaming wants 0-based character columns, at-mention 1-based
 * inclusive lines, omitted entirely for a whole file. */

export type MonacoSelectionLike = {
  startLineNumber: number;
  endLineNumber: number;
  startColumn: number;
  endColumn: number;
};

export type StreamRange = {
  startLine: number;
  endLine: number;
  startChar: number;
  endChar: number;
};

export type MentionRange = { startLine: number; endLine: number };

export function streamRangeFrom(sel: MonacoSelectionLike): StreamRange {
  return {
    startLine: sel.startLineNumber,
    endLine: sel.endLineNumber,
    startChar: sel.startColumn - 1,
    endChar: sel.endColumn - 1,
  };
}

/** `null` when nothing is selected, which is what lets one path serve both
 * gestures: no range means a whole-file mention. */
export function mentionRangeFrom(sel: MonacoSelectionLike | null | undefined): MentionRange | null {
  if (!sel) return null;
  const empty = sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn;
  if (empty) return null;
  const startLine = Math.min(sel.startLineNumber, sel.endLineNumber);
  let endLine = Math.max(sel.startLineNumber, sel.endLineNumber);
  // A triple-click parks the caret in column 1 of the *next* line, which the
  // user does not see as selected.
  if (sel.endColumn === 1 && endLine > startLine) endLine -= 1;
  return { startLine, endLine };
}

function lines(range: MentionRange, dash: string): string {
  return range.startLine === range.endLine
    ? `L${range.startLine}`
    : `L${range.startLine}${dash}${range.endLine}`;
}

/** Display text, so an en dash. */
export function formatLineRange(range: MentionRange): string {
  return lines(range, "–");
}

/** ASCII hyphen — Claude parses this one, it isn't display text. */
export function formatMentionRef(path: string, range: MentionRange | null): string {
  return range ? `${path}#${lines(range, "-")}` : path;
}

export function sameMentionRange(a: MentionRange | null, b: MentionRange | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.startLine === b.startLine && a.endLine === b.endLine;
}

/** The multi-diff holds both sides of every file; only the modified one maps to
 * something Claude can open. */
export function diffWorkPath(
  dir: string,
  uri: { scheme: string; path: string } | null | undefined,
): string | null {
  if (uri?.scheme !== "tt-diff-work") return null;
  const prefix = `${dir}/`;
  if (!uri.path.startsWith(prefix)) return null;
  return uri.path.slice(prefix.length);
}
