import { useCallback, type RefObject } from "react";
import { persistAgentboardSetting, useLiveSetting, useLiveSettingRef } from "./settings";

/** Built-in default for `agentboard.copyOnSelect` — on, matching tt-config. */
export const DEFAULT_COPY_ON_SELECT = true;

/** Built-in default for `agentboard.terminalFontSize` (px), matching tt-config. */
export const DEFAULT_TERMINAL_FONT_SIZE = 13;
/** Terminal font-size zoom bounds — small enough to stay legible, large enough
 * to fit a usable grid. */
export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 32;

/** Clamp/round an arbitrary px value into the supported terminal font range. */
export function clampTerminalFontSize(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.max(MIN_TERMINAL_FONT_SIZE, Math.min(MAX_TERMINAL_FONT_SIZE, Math.round(px)));
}

/**
 * Track the `agentboard.copyOnSelect` preference in a ref the terminal's render
 * effect can read live without re-subscribing. Re-reads on `SETTINGS_SAVED_EVENT`
 * (fired right after a successful save — see `useUserSettings` in `settings.ts`)
 * and on window focus (covers the JSON file being edited externally then
 * alt-tabbing back).
 */
export function useCopyOnSelect(): RefObject<boolean> {
  return useLiveSettingRef((s) => s.agentboard?.copyOnSelect, DEFAULT_COPY_ON_SELECT);
}

/**
 * Track the terminal font size (`agentboard.terminalFontSize`) as state so the
 * canvas render effect can key on it and re-measure the cell grid on change,
 * plus a setter that clamps, updates state, and persists back to the shared
 * settings file. Like {@link useCopyOnSelect}, we re-read on `SETTINGS_SAVED_EVENT`
 * and on window focus so a change made elsewhere flows back into this hook.
 */
export function useTerminalFontSize(): [number, (px: number) => void] {
  // Clamped in the selector too, not just on write: the file is hand-editable
  // and co-owned, so an out-of-range value can arrive from outside this app.
  const [fontSize, setFontSize] = useLiveSetting(
    (s) =>
      s.agentboard?.terminalFontSize === undefined
        ? undefined
        : clampTerminalFontSize(s.agentboard.terminalFontSize),
    DEFAULT_TERMINAL_FONT_SIZE,
  );
  const persist = useCallback(
    (px: number) => {
      const clamped = clampTerminalFontSize(px);
      setFontSize(clamped);
      void persistAgentboardSetting("terminalFontSize", clamped);
    },
    [setFontSize],
  );
  return [fontSize, persist];
}
