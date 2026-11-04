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

/** The blocks a diff summary fills, out of {@link DIFF_BLOCKS}: one per order
 * of magnitude of lines touched (so size reads at a glance, not as a count),
 * split between added and removed by their share, each side at least one. */
export const DIFF_BLOCKS = 5;

export function diffBlocks(added: number, removed: number): { add: number; del: number } {
  const total = added + removed;
  if (total === 0) return { add: 0, del: 0 };
  const filled = Math.min(DIFF_BLOCKS, Math.max(1, Math.ceil(Math.log10(total + 1))));
  if (removed === 0) return { add: filled, del: 0 };
  if (added === 0) return { add: 0, del: filled };
  if (filled === 1) return added >= removed ? { add: 1, del: 0 } : { add: 0, del: 1 };
  const add = Math.min(filled - 1, Math.max(1, Math.round((filled * added) / total)));
  return { add, del: filled - add };
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

/** Estimated dollar cost. Sub-cent figures round to `<$0.01` rather than `$0.00`
 * so a nonzero session never reads as free. */
export function fmtUsd(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01";
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n >= 100) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

/** On-disk sizes, 1024-based like `du -h`: `812 B`, `1.5 MB`, `325 MB`. One decimal
 * below 10 of a unit, none above, so a column of sizes stays short. */
export function fmtBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, n);
  let i = 0;
  // Promote on the *rounded* value, like `fmtTokens`: 1023.96 KB must not read "1024 KB".
  while (i < units.length - 1 && Math.round(value * 10) / 10 >= 1024) {
    value /= 1024;
    i++;
  }
  if (i === 0) return `${Math.round(value)} B`;
  const shown = value < 10 ? (Math.round(value * 10) / 10).toFixed(1) : String(Math.round(value));
  return `${shown} ${units[i]}`;
}

/** "1 task" / "3 tasks" — regular plurals only. */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
