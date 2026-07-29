import { useCallback } from "react";
import { persistAgentboardSetting, useLiveSetting } from "./settings";

export const DEFAULT_EDITOR_FONT_SIZE = 12;
export const MIN_EDITOR_FONT_SIZE = 8;
export const MAX_EDITOR_FONT_SIZE = 32;

export function clampEditorFontSize(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_EDITOR_FONT_SIZE;
  return Math.max(MIN_EDITOR_FONT_SIZE, Math.min(MAX_EDITOR_FONT_SIZE, Math.round(px)));
}

export function useEditorFontSize(): [number, (px: number) => void] {
  const [fontSize, setFontSize] = useLiveSetting(
    (s) =>
      s.agentboard?.editorFontSize === undefined
        ? undefined
        : clampEditorFontSize(s.agentboard.editorFontSize),
    DEFAULT_EDITOR_FONT_SIZE,
  );
  const persist = useCallback(
    (px: number) => {
      const clamped = clampEditorFontSize(px);
      setFontSize(clamped);
      void persistAgentboardSetting("editorFontSize", clamped);
    },
    [setFontSize],
  );
  return [fontSize, persist];
}
