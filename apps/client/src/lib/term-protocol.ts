/** Wire types for `terminal://frame`, mirroring crates/tt-vt/src/frame.rs. */

// Duplicated from shortcuts.tsx rather than imported: that module pulls in React UI.
const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform ?? "");

export interface Run {
  x: number;
  width: number;
  text: string;
  /** Packed 0xRRGGBB; absent = terminal default (theme color). */
  fg?: number;
  bg?: number;
  flags?: number;
  /** OSC 8 URI. Beats term-links.ts's regex: the text need not look like a URL. */
  link?: string;
  /** Style past single — 2 double, 3 curly, 4 dotted, 5 dashed (SGR 4:x). */
  ul?: number;
  /** SGR 58 underline color, packed; absent = underline in fg. */
  ulc?: number;
}

export interface RowUpdate {
  y: number;
  runs: Run[];
  /** libghostty's wrap bit — term-links joins rows on this, not on text width. */
  wrapped?: boolean;
  /** Row-local selected column range, inclusive. */
  sel?: [number, number];
}

export type CursorShape = "block" | "bar" | "underline" | "hollow";

export interface Cursor {
  x: number;
  y: number;
  visible: boolean;
  shape: CursorShape;
  blinking: boolean;
  /** Cursor color a program set (OSC 12), packed 0xRRGGBB; absent = theme. */
  color?: number;
  /** The program signalled password input — a lock hint renders in the cell. */
  password?: boolean;
}

/** Hints for input *routing* only — all encoding happens engine-side. */
export interface Modes {
  altScreen: boolean;
  mouseTracking: boolean;
}

export interface Frame {
  full: boolean;
  cols: number;
  rows: number;
  changed: RowUpdate[];
  cursor: Cursor;
  colors: { fg: number; bg: number };
  modes: Modes;
  title?: string;
  scrollbackRows: number;
  /** Absolute index of the viewport's top row (0 = oldest scrollback row).
   * Also the origin `term_select`'s coordinates are sent in. */
  viewportTop: number;
  /** A selection exists — not the same as "a visible row carries `sel`",
   * which goes false the moment it scrolls out of view. */
  selection: boolean;
}

/** A signal death leaves `code` at portable-pty's placeholder — prefer `signal`. */
export interface TermExit {
  termId: string;
  code: number;
  signal?: string | null;
}

export function exitLabel(code: number, signal?: string | null): string {
  if (signal) return `exited · ${signal}`;
  if (code === 0) return "exited";
  return `exited · code ${code}`;
}

/** A crash is the one exit you'd never learn about, so only it earns a toast. */
export function exitIsCrash(code: number, signal?: string | null): boolean {
  return code !== 0 || signal != null;
}

/** Drops scrollback; forces a full frame so the view learns the depth collapsed. */
export const TERM_CLEAR_COMMAND = "term_clear";

export interface SearchMatch {
  row: number;
  col: number;
  width: number;
}

export function viewportMatches(
  matches: SearchMatch[],
  viewportTop: number,
  rows: number,
): { y: number; col: number; width: number; index: number }[] {
  const out: { y: number; col: number; width: number; index: number }[] = [];
  for (let index = 0; index < matches.length; index++) {
    const m = matches[index];
    const y = m.row - viewportTop;
    if (y >= 0 && y < rows) out.push({ y, col: m.col, width: m.width, index });
  }
  return out;
}

export function stepMatch(count: number, current: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  return (((current + dir) % count) + count) % count;
}

// Run style flag bits (crates/tt-vt/src/frame.rs `flags` module).
export const BOLD = 1;
export const ITALIC = 1 << 1;
export const FAINT = 1 << 2;
export const UNDERLINE = 1 << 3;
export const INVERSE = 1 << 4;
export const INVISIBLE = 1 << 5;
export const STRIKETHROUGH = 1 << 6;
export const OVERLINE = 1 << 7;

export function rgb(packed: number): string {
  return `#${packed.toString(16).padStart(6, "0")}`;
}

const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** One cluster fills one cell: combining marks must not advance the grid twice. */
export function graphemeClusters(text: string): string[] {
  if (!graphemeSegmenter) return [...text];
  const out: string[] = [];
  for (const { segment } of graphemeSegmenter.segment(text)) out.push(segment);
  return out;
}

export function isWideRun(run: Run): boolean {
  return run.width > graphemeClusters(run.text).length;
}

type KeyEventLike = Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">;

export type ScrollbackAction = "page-up" | "page-down" | "top" | "bottom";

/** The canvas view drives its own scrollback for these, never the shell. */
export function scrollbackKey(e: KeyEventLike): ScrollbackAction | null {
  if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return null;
  switch (e.key) {
    case "PageUp":
      return "page-up";
    case "PageDown":
      return "page-down";
    case "Home":
      return "top";
    case "End":
      return "bottom";
    default:
      return null;
  }
}

/** The engine encodes this against live terminal state; no escapes built here. */
export interface KeyEventWire {
  code: string;
  key: string;
  action: "press" | "repeat" | "release";
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  capsLock: boolean;
  numLock: boolean;
}

export type KeyWireEventLike = KeyEventLike &
  Pick<KeyboardEvent, "code" | "repeat"> & {
    getModifierState?: (key: string) => boolean;
  };

/** Wired to the engine, but never "the user typed something" — no jump to bottom. */
export const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "NumLock"]);

/** Shared with `keyEventWire` below, which must yield the same keystroke. Mac
 * takes Ctrl+Shift as well as ⌘⇧, matching the shortcut registry's alias —
 * bare Ctrl stays the shell's, so ⌃C is still SIGINT. */
export function isCopyChord(e: KeyEventLike): boolean {
  return chordMod(e) && e.shiftKey && (e.key === "C" || e.key === "c");
}

export function isPasteChord(e: KeyEventLike): boolean {
  return chordMod(e) && e.shiftKey && (e.key === "V" || e.key === "v");
}

function chordMod(e: KeyEventLike): boolean {
  return IS_MAC ? e.metaKey || e.ctrlKey : e.ctrlKey;
}

/** null when the keystroke isn't the shell's to consume — Meta stays with the OS,
 * Ctrl/⌘+Shift+C/V are the app's. Everything else the engine decides. */
export function keyEventWire(
  e: KeyWireEventLike,
  action: "press" | "release" = "press",
): KeyEventWire | null {
  if (e.metaKey) return null;
  if (isCopyChord(e) || isPasteChord(e)) return null;
  return {
    code: e.code,
    key: e.key,
    action: action === "press" && e.repeat ? "repeat" : action,
    shift: e.shiftKey,
    alt: e.altKey,
    ctrl: e.ctrlKey,
    meta: e.metaKey,
    capsLock: e.getModifierState?.("CapsLock") ?? false,
    numLock: e.getModifierState?.("NumLock") ?? false,
  };
}

// Paste encoding is the engine's: libghostty strips bytes that escape the bracket.
