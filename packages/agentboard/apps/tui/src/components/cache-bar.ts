import type { Theme } from "@tt-agentboard/runtime";

export const CACHE_BAR_WIDTH = 10;
export const CACHE_BAR_FILLED = "▰";
export const CACHE_BAR_EMPTY = "▱";

/** Render a drain-down bar: full = freshly cached, empty = expired. */
export function cacheBar(expiresAt: number, ttlMs: number, now: number): string {
  const remaining = expiresAt - now;
  if (remaining <= 0 || ttlMs <= 0) return CACHE_BAR_EMPTY.repeat(CACHE_BAR_WIDTH);
  const fraction = Math.max(0, Math.min(1, remaining / ttlMs));
  const filled = Math.round(fraction * CACHE_BAR_WIDTH);
  return CACHE_BAR_FILLED.repeat(filled) + CACHE_BAR_EMPTY.repeat(CACHE_BAR_WIDTH - filled);
}

export function shortModel(model: string): string {
  if (!model) return "";
  return model.replace(/^claude-/, "").replace(/\[1m\]$/i, "");
}

export function cacheBarColor(
  expiresAt: number,
  ttlMs: number,
  now: number,
  palette: Theme["palette"],
): string {
  const remaining = expiresAt - now;
  if (remaining <= 0 || ttlMs <= 0) return palette.overlay0;
  const fraction = remaining / ttlMs;
  if (fraction > 0.5) return palette.green;
  if (fraction > 0.2) return palette.yellow;
  return palette.peach;
}
