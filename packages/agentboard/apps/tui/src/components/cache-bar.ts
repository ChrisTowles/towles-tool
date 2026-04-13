import type { Theme } from "@tt-agentboard/runtime";

export const CACHE_BAR_WIDTH = 10;
export const CACHE_BAR_FILLED = "▰";
export const CACHE_BAR_EMPTY = "▱";

export interface CacheBarVisual {
  bar: string;
  color: string;
}

/** Drain-down bar + traffic-light color: full/green when fresh, empty/grey when expired. */
export function cacheBarVisual(
  expiresAt: number,
  ttlMs: number,
  now: number,
  palette: Theme["palette"],
): CacheBarVisual {
  const remaining = expiresAt - now;
  if (remaining <= 0 || ttlMs <= 0) {
    return { bar: CACHE_BAR_EMPTY.repeat(CACHE_BAR_WIDTH), color: palette.overlay0 };
  }
  const fraction = Math.max(0, Math.min(1, remaining / ttlMs));
  const filled = Math.round(fraction * CACHE_BAR_WIDTH);
  const bar = CACHE_BAR_FILLED.repeat(filled) + CACHE_BAR_EMPTY.repeat(CACHE_BAR_WIDTH - filled);
  const color = fraction > 0.5 ? palette.green : fraction > 0.2 ? palette.yellow : palette.peach;
  return { bar, color };
}

export function shortModel(model: string): string {
  if (!model) return "";
  return model.replace(/^claude-/, "").replace(/\[1m\]$/i, "");
}
