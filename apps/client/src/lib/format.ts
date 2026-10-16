/** Display formatters shared across screens: one output style per quantity. */

/** Token counts at a glance: `53K`, `412K`, `1M`. */
export function fmtTokens(n: number): string {
  if (n < 1_000) return `${n}`;
  const k = Math.round(n / 1_000);
  // Promote on the *rounded* value: 999_500 rounds to 1000K, which reads as 1M.
  if (k < 1_000) return `${k}K`;
  const m = Math.round(n / 100_000) / 10;
  // 1M, not 1.0M — but keep 1.5M's fraction. Tested after rounding.
  return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
}

/** Diff magnitudes for a rail chip: `847`, `12.3K`, `1.2M`. */
export function fmtDiffLines(n: number): string {
  if (n < 10_000) return `${n}`;
  const k = n / 1_000;
  if (k < 100) return `${Math.round(k * 10) / 10}K`;
  // Promote on the *rounded* value, like `fmtTokens`.
  const rounded = Math.round(k);
  if (rounded < 1_000) return `${rounded}K`;
  const m = Math.round(n / 100_000) / 10;
  return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
}

/** `0:04` / `3:20` / `1:02:30` — elapsed duration since a session started. */
export function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** `4h 12m` / `12m 30s` / `8s` — day-scale totals, unlike `fmtElapsed`'s clock.
 * Non-zero under a second is `<1s`, never `0s`: a real subprocess rendered as a
 * flat zero reads as "this didn't happen". */
export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  if (s === 0 && ms > 0) return "<1s";
  return `${s}s`;
}
