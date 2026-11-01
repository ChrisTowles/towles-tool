/** Millis → whole minutes for the cache countdown, floored at 1 ("<1m" ≈ 1m). */
export function fmtMins(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}
