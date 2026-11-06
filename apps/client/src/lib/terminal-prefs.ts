import { persistAgentboardSetting, readSetting, useSetting } from "./settings";

/** Built-in default for `agentboard.copyOnSelect` — on, matching tt-config. */
const DEFAULT_COPY_ON_SELECT = true;

/** Built-in default for `agentboard.terminalFontSize` (px), matching tt-config. */
export const DEFAULT_TERMINAL_FONT_SIZE = 13;
/** Terminal font-size zoom bounds — small enough to stay legible, large enough
 * to fit a usable grid. */
const MIN_TERMINAL_FONT_SIZE = 8;
const MAX_TERMINAL_FONT_SIZE = 32;

/** Clamp/round an arbitrary px value into the supported terminal font range. */
export function clampTerminalFontSize(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.max(MIN_TERMINAL_FONT_SIZE, Math.min(MAX_TERMINAL_FONT_SIZE, Math.round(px)));
}

/** `agentboard.copyOnSelect` as of now, for the terminal's mouse handler. */
export const readCopyOnSelect = (): boolean =>
  readSetting((s) => s.agentboard?.copyOnSelect, DEFAULT_COPY_ON_SELECT);

/** Terminal font size as state, so the canvas render effect can key on it and
 * re-measure the cell grid on change; the setter clamps and persists. */
export function useTerminalFontSize(): [number, (px: number) => void] {
  // Clamped in the selector too, not just on write: the file is hand-editable
  // and co-owned, so an out-of-range value can arrive from outside this app.
  const fontSize = useSetting(
    (s) =>
      s.agentboard?.terminalFontSize === undefined
        ? undefined
        : clampTerminalFontSize(s.agentboard.terminalFontSize),
    DEFAULT_TERMINAL_FONT_SIZE,
  );
  return [fontSize, setTerminalFontSize];
}

const setTerminalFontSize = (px: number) =>
  persistAgentboardSetting("terminalFontSize", clampTerminalFontSize(px));
