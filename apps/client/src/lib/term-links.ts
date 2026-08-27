/** Link detection over the terminal grid mirror, so the canvas terminal can make
 * URLs and file paths hoverable. Rows join on the engine's soft-wrap flag and on
 * the hard wrap an Ink/`wrap-ansi` TUI does itself — Claude Code breaks a long
 * path mid-token at its box edge, where the grid never sees a soft wrap. */

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

export interface GridLine {
  runs: Run[];
  wrapped?: boolean;
}

const URL_RE = /https?:\/\/[^\s"'`<>]+/g;
/** Deliberately over-matches any `word.ext` token; `isPathLike` then rejects
 * prose like `example.com` or a bare `1.2.3` version. */
const PATH_RE = /(?:\/|\.\.?\/|~\/)?(?:[\w.@~+-]+\/)*[\w.@~+-]+\.[A-Za-z0-9]+(?::\d+(?::\d+)?)?/g;
const TRAILING = new Set([".", ",", ";", ":", "!", "?"]);
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
/** How many rows a wrapped link may span in either direction from the probe. */
const MAX_WRAP_ROWS = 4;
/** Characters a hard wrap may split a link on; both sides of the break must
 * match, so prose lines that merely reach the edge are not glued together. */
const GLUE_RE = /[\w./@~+:%#?&=-]/;
/** Widest left padding read as a box gutter rather than real indentation. */
const MAX_GUTTER = 8;

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

interface RowCells {
  text: string;
  links: (string | undefined)[];
  softWrapped: boolean;
}

/** Grid cell a joined-block character came from. */
interface Cell {
  y: number;
  x: number;
}

/** A cell holds content when it is not blank, or when it is a linked blank —
 * OSC 8 runs of spaces are addressable and must not be trimmed away. */
function held(row: RowCells, x: number): boolean {
  return row.text[x] !== " " || row.links[x] !== undefined;
}

function firstHeld(row: RowCells): number {
  for (let x = 0; x < row.text.length; x++) if (held(row, x)) return x;
  return -1;
}

function lastHeld(row: RowCells): number {
  for (let x = row.text.length - 1; x >= 0; x--) if (held(row, x)) return x;
  return -1;
}

/** Columns `x` runs back/forward over before hitting a blank. */
function tokenBack(row: RowCells, x: number): number {
  let i = x;
  while (i > 0 && row.text[i - 1] !== " ") i--;
  return x - i + 1;
}

function tokenForward(row: RowCells, x: number): number {
  let i = x;
  while (i + 1 < row.text.length && row.text[i + 1] !== " ") i++;
  return i - x + 1;
}

/** Whether `a` runs into `b` as a TUI's own hard wrap. `b`'s indent is the tell:
 * a self-wrapping emitter is drawing a box, so `a` must reach the edge that
 * gutter implies (Claude Code pads 0 right in the body, 2 in the input box) and,
 * as `wrap-ansi` splits only an unfittable token, the halves out-measure it. */
function hardWrapsInto(a: RowCells, b: RowCells, cols: number): boolean {
  const end = lastHeld(a);
  const start = firstHeld(b);
  const gutter = Math.min(start, MAX_GUTTER);
  if (end < 0 || gutter < 1 || end < cols - 1 - gutter) return false;
  if (!GLUE_RE.test(a.text[end]) || !GLUE_RE.test(b.text[start])) return false;
  return tokenBack(a, end) + tokenForward(b, start) > cols - 2 * gutter;
}

/** Contiguous columns around `x` that carry `uri`. */
function uriRun(row: RowCells, uri: string, x: number): [number, number] {
  let start = x;
  while (start > 0 && row.links[start - 1] === uri) start--;
  let end = x;
  while (end < row.links.length - 1 && row.links[end + 1] === uri) end++;
  return [start, end];
}

/** An OSC 8 link the emitter broke over rows: `wrap-ansi` closes the hyperlink
 * before the newline and reopens the same URI after it, so the halves meet at
 * one row's last held cell and the next row's first. */
function hyperlinkSegments(rows: RowCells[], uri: string, x: number, y: number): LinkSegment[] {
  const spans = new Map<number, [number, number]>();
  spans.set(y, uriRun(rows[y], uri, x));
  for (let r = y; r > 0 && y - r < MAX_WRAP_ROWS; r--) {
    const above = rows[r - 1];
    const edge = lastHeld(above);
    if (spans.get(r)![0] !== firstHeld(rows[r]) || edge < 0 || above.links[edge] !== uri) break;
    spans.set(r - 1, uriRun(above, uri, edge));
  }
  for (let r = y; r + 1 < rows.length && r - y < MAX_WRAP_ROWS; r++) {
    const below = rows[r + 1];
    const edge = firstHeld(below);
    if (spans.get(r)![1] !== lastHeld(rows[r]) || edge < 0 || below.links[edge] !== uri) break;
    spans.set(r + 1, uriRun(below, uri, edge));
  }
  return [...spans.entries()]
    .toSorted((a, b) => a[0] - b[0])
    .map(([y2, [start, end]]) => ({ y: y2, start, end }));
}

interface Block {
  text: string;
  at: Cell[];
  probe: number;
}

/** The wrap-joined text around row `y`, with each hard-wrap continuation's
 * gutter and the preceding row's padding dropped so a split token reads whole. */
function blockAround(rows: RowCells[], cols: number, x: number, y: number): Block | null {
  const cont = (r: number) =>
    rows[r + 1] !== undefined && (rows[r].softWrapped || hardWrapsInto(rows[r], rows[r + 1], cols));

  let top = y;
  while (y - top < MAX_WRAP_ROWS && top > 0 && cont(top - 1)) top--;
  let bottom = y;
  while (bottom - y < MAX_WRAP_ROWS && bottom + 1 < rows.length && cont(bottom)) bottom++;

  const from = new Map<number, number>();
  const to = new Map<number, number>();
  for (let r = top; r <= bottom; r++) {
    from.set(r, 0);
    to.set(r, cols);
  }
  for (let r = top; r < bottom; r++) {
    if (rows[r].softWrapped) continue;
    to.set(r, lastHeld(rows[r]) + 1);
    from.set(r + 1, firstHeld(rows[r + 1]));
  }

  const chars: string[] = [];
  const at: Cell[] = [];
  let probe = -1;
  for (let r = top; r <= bottom; r++) {
    for (let c = from.get(r)!; c < to.get(r)!; c++) {
      if (r === y && c === x) probe = chars.length;
      chars.push(rows[r].text[c]);
      at.push({ y: r, x: c });
    }
  }
  return probe < 0 ? null : { text: chars.join(""), at, probe };
}

/** Merge the cells `start..end` of a block into per-row column ranges. */
function segmentsOf(at: Cell[], start: number, end: number): LinkSegment[] {
  const segments: LinkSegment[] = [];
  for (let i = start; i <= end; i++) {
    const cell = at[i];
    const last = segments.at(-1);
    if (last && last.y === cell.y && last.end === cell.x - 1) last.end = cell.x;
    else segments.push({ y: cell.y, start: cell.x, end: cell.x });
  }
  return segments;
}

/** The link under viewport cell (x, y), or null. URLs win over paths where both
 * could match, since URL spans are masked out before path detection. */
export function linkAt(lines: GridLine[], cols: number, x: number, y: number): TermLink | null {
  if (cols <= 0 || x < 0 || y < 0 || y >= lines.length) return null;

  const rows: RowCells[] = lines.map((line) => ({
    text: rowText(line?.runs ?? [], cols),
    links: rowLinks(line?.runs ?? [], cols),
    softWrapped: line?.wrapped === true,
  }));

  // A real OSC 8 hyperlink outranks the regexes below: its text may not look like one.
  const hyperlink = rows[y].links[x];
  if (hyperlink) {
    const segments = hyperlinkSegments(rows, hyperlink, x, y);
    const file = fileUrlToPath(hyperlink);
    if (file) return { kind: "path", path: file.path, line: file.line, segments };
    return { kind: "url", url: hyperlink, segments };
  }

  const block = blockAround(rows, cols, x, y);
  if (!block) return null;
  const { text: joined, at, probe } = block;

  for (const m of joined.matchAll(URL_RE)) {
    const url = trimTrailing(m[0]);
    if (url.length <= "https://".length) continue;
    const start = m.index;
    const end = start + url.length - 1; // inclusive
    if (probe < start || probe > end) continue;
    return { kind: "url", url, segments: segmentsOf(at, start, end) };
  }

  const masked = maskUrls(joined);
  for (const m of masked.matchAll(PATH_RE)) {
    const raw = trimTrailing(m[0]);
    const start = m.index;
    const end = start + raw.length - 1; // inclusive
    if (!isPathLike(raw) && !isToolHeaderArg(masked, start, end)) continue;
    if (probe < start || probe > end) continue;
    const { path, line } = splitPathLine(raw);
    return { kind: "path", path, line, segments: segmentsOf(at, start, end) };
  }
  return null;
}
