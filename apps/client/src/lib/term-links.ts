/** Link detection over the terminal grid mirror, so the canvas terminal can make
 * URLs and file paths hoverable. Rows are joined across soft wraps via the
 * engine's per-row `wrapped` flag — that is how a CLI's long link spans lines. */

import { isWideRun, type Run } from "@/lib/term-protocol";

export interface LinkSegment {
  y: number;
  /** Inclusive viewport column range. */
  start: number;
  end: number;
}

export interface UrlLink {
  kind: "url";
  url: string;
  segments: LinkSegment[];
}

export interface PathLink {
  kind: "path";
  path: string;
  line: number | null;
  segments: LinkSegment[];
}

export type TermLink = UrlLink | PathLink;

export function linkLabel(link: TermLink): string {
  if (link.kind === "url") return link.url;
  return link.line != null ? `${link.path}:${link.line}` : link.path;
}

const URL_RE = /https?:\/\/[^\s"'`<>]+/g;
/** Deliberately over-matches any `word.ext` token; `isPathLike` then rejects
 * prose like `example.com` or a bare `1.2.3` version. */
const PATH_RE = /(?:\/|\.\.?\/|~\/)?(?:[\w.@~+-]+\/)*[\w.@~+-]+\.[A-Za-z0-9]+(?::\d+(?::\d+)?)?/g;
const TRAILING = new Set([".", ",", ";", ":", "!", "?"]);
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
/** How many rows a wrapped link may span in either direction from the probe. */
const MAX_WRAP_ROWS = 4;

/** Length = `cols`, so string indices equal terminal columns. */
export function rowText(runs: Run[], cols: number): string {
  // Once per row per frame: `Array.from({length}).fill()` visits every index twice.
  // oxlint-disable-next-line unicorn/no-new-array
  const chars = new Array<string>(cols).fill(" ");
  for (const run of runs) {
    const wide = isWideRun(run);
    let x = run.x;
    for (const ch of run.text) {
      if (x >= cols) break;
      chars[x] = ch;
      x += wide && ch.charCodeAt(0) > 0xff ? 2 : 1;
    }
  }
  return chars.join("");
}

/** The engine only merges cells sharing a link, so a run never straddles a
 * link boundary — its `link` applies to every column it spans. */
export function rowLinks(runs: Run[], cols: number): (string | undefined)[] {
  // oxlint-disable-next-line unicorn/no-new-array
  const out = new Array<string | undefined>(cols).fill(undefined);
  if (cols <= 0) return out;
  for (const run of runs) {
    if (!run.link) continue;
    const end = Math.min(run.x + run.width, cols);
    for (let x = run.x; x < end; x++) out[x] = run.link;
  }
  return out;
}

/** CLIs hyperlink the paths they print, and handing those to the system opener
 * as web URLs silently does nothing — a `file://` URI is a *path* link. Line
 * may arrive as `&line=`/`?line=`/`#L` (Claude Code omits the `?`). */
export function fileUrlToPath(url: string): { path: string; line: number | null } | null {
  if (!url.startsWith("file://")) return null;
  let rest = url.slice("file://".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  rest = rest.slice(slash);
  const cut = rest.search(/[?&#]/);
  const rawPath = cut < 0 ? rest : rest.slice(0, cut);
  const suffix = cut < 0 ? "" : rest.slice(cut);
  const m = suffix.match(/[?&#](?:line=|L)(\d+)/);
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    path = rawPath;
  }
  return { path, line: m ? Number.parseInt(m[1], 10) : null };
}

function trimTrailing(text: string): string {
  let end = text.length;
  while (end > 0) {
    const ch = text[end - 1];
    if (TRAILING.has(ch)) {
      end--;
      continue;
    }
    const opener = CLOSERS[ch];
    if (opener) {
      const body = text.slice(0, end);
      const opens = [...body].filter((c) => c === opener).length;
      const closes = [...body].filter((c) => c === ch).length;
      if (closes > opens) {
        end--;
        continue;
      }
    }
    break;
  }
  return text.slice(0, end);
}

/** Same length, so indices stay aligned; stops paths re-claiming a URL's tail. */
function maskUrls(joined: string): string {
  return joined.replace(URL_RE, (m) => " ".repeat(m.length));
}

function isPathLike(raw: string): boolean {
  return raw.includes("/") || /:\d/.test(raw);
}

/** A bare `name.ext` is still a path as the whole argument of an agent tool-call
 * header — `Update(README.md)`. The `CapitalizedWord(…)` wrapper is the anchor. */
function isToolHeaderArg(text: string, start: number, end: number): boolean {
  if (text[start - 1] !== "(" || text[end + 1] !== ")") return false;
  let i = start - 2;
  while (i >= 0 && /[A-Za-z]/.test(text[i])) i--;
  return /^[A-Z][A-Za-z]+$/.test(text.slice(i + 1, start - 1));
}

function splitPathLine(raw: string): { path: string; line: number | null } {
  const colon = raw.indexOf(":");
  if (colon < 0) return { path: raw, line: null };
  const line = Number.parseInt(raw.slice(colon + 1), 10);
  return { path: raw.slice(0, colon), line: Number.isNaN(line) ? null : line };
}

/** Offsets are into the wrap-joined block starting at viewport row `startRow`. */
function segmentsFor(start: number, end: number, startRow: number, cols: number): LinkSegment[] {
  const segments: LinkSegment[] = [];
  const first = Math.floor(start / cols);
  const last = Math.floor(end / cols);
  for (let r = first; r <= last; r++) {
    segments.push({
      y: startRow + r,
      start: r === first ? start % cols : 0,
      end: r === last ? end % cols : cols - 1,
    });
  }
  return segments;
}

/** The link under viewport cell (x, y), or null. URLs win over paths where both
 * could match, since URL spans are masked out before path detection. */
export function linkAt(
  lines: { runs: Run[]; wrapped?: boolean }[],
  cols: number,
  x: number,
  y: number,
): TermLink | null {
  if (cols <= 0 || x < 0 || y < 0 || y >= lines.length) return null;

  const text = (row: number) => rowText(lines[row]?.runs ?? [], cols);

  // The wrapped block containing row y: up while the row above flows into ours.
  let startRow = y;
  while (y - startRow < MAX_WRAP_ROWS && startRow > 0 && lines[startRow - 1]?.wrapped) {
    startRow--;
  }
  let endRow = y;
  while (endRow - y < MAX_WRAP_ROWS && endRow + 1 < lines.length && lines[endRow]?.wrapped) {
    endRow++;
  }

  const rows: string[] = [];
  const linkRows: (string | undefined)[] = [];
  for (let r = startRow; r <= endRow; r++) {
    rows.push(text(r));
    linkRows.push(...rowLinks(lines[r]?.runs ?? [], cols));
  }
  const joined = rows.join("");
  const probe = (y - startRow) * cols + x;

  // A real OSC 8 hyperlink outranks the regexes below: its text may not look like one.
  const hyperlink = linkRows[probe];
  if (hyperlink) {
    let start = probe;
    while (start > 0 && linkRows[start - 1] === hyperlink) start--;
    let end = probe;
    while (end < linkRows.length - 1 && linkRows[end + 1] === hyperlink) end++;
    const segments = segmentsFor(start, end, startRow, cols);
    const file = fileUrlToPath(hyperlink);
    if (file) return { kind: "path", path: file.path, line: file.line, segments };
    return { kind: "url", url: hyperlink, segments };
  }

  for (const m of joined.matchAll(URL_RE)) {
    const url = trimTrailing(m[0]);
    if (url.length <= "https://".length) continue;
    const start = m.index;
    const end = start + url.length - 1; // inclusive
    if (probe < start || probe > end) continue;
    return { kind: "url", url, segments: segmentsFor(start, end, startRow, cols) };
  }

  const masked = maskUrls(joined);
  for (const m of masked.matchAll(PATH_RE)) {
    const raw = trimTrailing(m[0]);
    const start = m.index;
    const end = start + raw.length - 1; // inclusive
    if (!isPathLike(raw) && !isToolHeaderArg(masked, start, end)) continue;
    if (probe < start || probe > end) continue;
    const { path, line } = splitPathLine(raw);
    return { kind: "path", path, line, segments: segmentsFor(start, end, startRow, cols) };
  }
  return null;
}
