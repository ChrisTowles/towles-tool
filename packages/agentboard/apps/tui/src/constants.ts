import { TextAttributes } from "@opentui/core";
import { BUILTIN_THEMES, TUI_RESIZE_LOG } from "@tt-agentboard/runtime";
import type { Theme, MetadataTone } from "@tt-agentboard/runtime";
import { appendFileSync } from "node:fs";

export const SPINNERS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const UNSEEN_ICON = "●";
export const BOLD = TextAttributes.BOLD;
export const DIM = TextAttributes.DIM;
export const DIVIDER = "─".repeat(200);

export const THEME_NAMES = Object.keys(BUILTIN_THEMES);
export { TUI_RESIZE_LOG };

export function toneColor(tone: MetadataTone | undefined, palette: Theme["palette"]): string {
  switch (tone) {
    case "success":
      return palette.green;
    case "error":
      return palette.red;
    case "warn":
      return palette.yellow;
    case "info":
      return palette.blue;
    default:
      return palette.overlay0;
  }
}

export function logResizeDebug(message: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const extra = data ? ` ${JSON.stringify(data)}` : "";
  try {
    appendFileSync(TUI_RESIZE_LOG, `[${ts}] [pid:${process.pid}] ${message}${extra}\n`);
  } catch {}
}
