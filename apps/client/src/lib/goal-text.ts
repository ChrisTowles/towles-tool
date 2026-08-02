export type GoalSegment = {
  text: string;
  kind: "plain" | "url" | "ref";
};

const TOKEN = /(https?:\/\/[^\s<>()]+)|(#\d+)\b/g;

/** The concatenated segment texts always equal the input, so the highlight
 * overlay can't drift out of alignment with the textarea it sits behind. */
export function highlightSegments(text: string): GoalSegment[] {
  const out: GoalSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index;
    if (start > last) out.push({ text: text.slice(last, start), kind: "plain" });
    out.push({ text: m[0], kind: m[1] ? "url" : "ref" });
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), kind: "plain" });
  return out;
}

/** A mention only counts when its `#` starts a word — otherwise a URL fragment
 * like `…/pull/4#issuecomment` would pop the issue list mid-paste. */
export function mentionQueryAt(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  let i = caret;
  while (i > 0 && /[\w-]/.test(text[i - 1])) i -= 1;
  if (i === 0 || text[i - 1] !== "#") return null;
  const start = i - 1;
  if (start > 0 && !/\s/.test(text[start - 1])) return null;
  return { start, query: text.slice(i, caret) };
}

export function applyMention(
  text: string,
  start: number,
  caret: number,
  issueNumber: number,
): { text: string; caret: number } {
  const insert = `#${issueNumber} `;
  return {
    text: text.slice(0, start) + insert + text.slice(caret),
    caret: start + insert.length,
  };
}

/** Adds a leading space when the caret sits against a word: {@link mentionQueryAt}
 * only recognises a `#` that starts one, so without it the button would do nothing. */
export function insertMentionTrigger(text: string, caret: number): { text: string; caret: number } {
  const before = text.slice(0, caret);
  const insert = before.length > 0 && !/\s$/.test(before) ? " #" : "#";
  return {
    text: before + insert + text.slice(caret),
    caret: caret + insert.length,
  };
}

/** An all-digit query matches on number, not title: `#12` must surface #123
 * ahead of anything whose title happens to contain "12". */
export function matchIssues<T extends { number: number; title: string }>(
  issues: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return issues;
  if (/^\d+$/.test(q)) return issues.filter((i) => String(i.number).startsWith(q));
  return issues.filter((i) => i.title.toLowerCase().includes(q));
}

/** Reuses {@link highlightSegments}'s classification so a URL fragment is never
 * mistaken for a reference — same rule, one source of truth. */
export function referencedIssueNumbers(text: string): number[] {
  const seen = new Set<number>();
  for (const seg of highlightSegments(text)) {
    if (seg.kind !== "ref") continue;
    seen.add(Number(seg.text.slice(1)));
  }
  return [...seen];
}
