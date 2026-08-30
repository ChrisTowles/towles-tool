import type { BuildDelta, BuildKey, BuildSnapshot } from "@/lib/telemetry";

/** Pure logic behind the Builds tab: which pair to compare, how a delta reads.
 * The "read" column is derived from the numbers alone — it names a pattern,
 * never a cause. */

export const TELEMETRY_BUILDS_KEY = "tt-telemetry-builds";

/** A snapshot thinner than this is a restart, not a day of use. */
export const MIN_SNAPSHOT_RECORDS = 500;

/** Mirrors `tt_telemetry::MIN_FOCUS_MS`: below it the per-hour sides are null. */
export const MIN_FOCUS_MS = 10 * 60_000;

export type BuildPair = { base: BuildKey; other: BuildKey };

export const sameKey = (a: BuildKey, b: BuildKey) => a.sha === b.sha && a.day === b.day;

export const shortSha = (sha: string) => (sha === "unknown" ? sha : sha.slice(0, 7));

/** `Aug 28` from a `YYYY-MM-DD` file date — a UTC day, so no timezone shift. */
export function shortDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export const snapshotLabel = (key: BuildKey) => `${shortSha(key.sha)} · ${shortDay(key.day)}`;

/** Candidate is the newest substantial snapshot, baseline the one before it;
 * with fewer than two substantial ones, the newest two of any size. `snapshots`
 * arrive newest first. */
export function defaultPair(snapshots: BuildSnapshot[]): BuildPair | null {
  const big = snapshots.filter((s) => s.recordCount >= MIN_SNAPSHOT_RECORDS);
  const pool = big.length >= 2 ? big : snapshots;
  if (pool.length < 2) return null;
  return { base: keyOf(pool[1]), other: keyOf(pool[0]) };
}

export const keyOf = (s: BuildSnapshot): BuildKey => ({ sha: s.sha, day: s.day });

/** A stored pair survives only while both snapshots are still on disk. */
export function resolvePair(
  stored: BuildPair | null,
  snapshots: BuildSnapshot[],
): BuildPair | null {
  if (
    stored &&
    snapshots.some((s) => sameKey(s, stored.base)) &&
    snapshots.some((s) => sameKey(s, stored.other))
  ) {
    return stored;
  }
  return defaultPair(snapshots);
}

function isKey(v: unknown): v is BuildKey {
  if (typeof v !== "object" || v === null) return false;
  const k = v as Record<string, unknown>;
  return typeof k.sha === "string" && typeof k.day === "string";
}

export function loadBuildsPair(raw: string | null): BuildPair | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  return isKey(p.base) && isKey(p.other) ? { base: p.base, other: p.other } : null;
}

export function saveBuildsPair(pair: BuildPair): void {
  localStorage.setItem(TELEMETRY_BUILDS_KEY, JSON.stringify(pair));
}

export type Verdict = "better" | "worse" | "same" | "neutral" | "none";

/** Colour follows the measure's direction, not the sign. */
export function verdict(delta: number | null, direction: BuildDelta["direction"]): Verdict {
  if (delta === null) return "none";
  if (delta === 0) return "same";
  if (direction === "neutral") return "neutral";
  const improved = direction === "lowerIsBetter" ? delta < 0 : delta > 0;
  return improved ? "better" : "worse";
}

const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "");

function fixed(n: number, digits: number): string {
  return Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** A value in its unit; `perHour` renders counts and minutes as rates. */
export function fmtValue(value: number | null, unit: BuildDelta["unit"], perHour = false): string {
  if (value === null) return "—";
  const suffix = perHour ? "/h" : "";
  switch (unit) {
    case "count":
      return `${perHour ? fixed(value, 1) : fixed(value, 0)}${suffix}`;
    case "percent":
      return `${fixed(value, 1)}%`;
    case "ms":
      return `${fixed(value, 0)} ms`;
    case "minutes":
      return `${fixed(value, 1)} min${suffix}`;
  }
}

/** Signed, so `+3` and `−3` read at a glance; percent deltas are in points. */
export function fmtDelta(delta: number | null, unit: BuildDelta["unit"], perHour = false): string {
  if (delta === null) return "—";
  if (delta === 0) return "0";
  if (unit === "percent") return `${sign(delta)}${fixed(delta, 1)} pt`;
  return `${sign(delta)}${fmtValue(Math.abs(delta), unit, perHour)}`;
}

const DAY_EFFECT_RATIO = 3;

/** The short factual note beside a row. In the raw view an extensive measure
 * whose per-hour delta points the other way, or is a third the size, is a "day
 * effect": the day was longer or shorter, not the build different. */
export function readOf(d: BuildDelta, normalized: boolean): string {
  const shown = normalized && d.perHour ? d.perHour : d;
  if (shown.delta === null) {
    return normalized && d.perHour ? "under 10 min focused" : "no data";
  }
  if (shown.delta === 0) return "unchanged";
  if (shown.other === 0) return "now zero";
  if (!normalized && d.perHour && d.perHour.delta !== null && d.base && d.perHour.base) {
    const raw = d.delta! / d.base;
    const rate = d.perHour.delta / d.perHour.base;
    if (Math.sign(raw) !== Math.sign(rate) || Math.abs(rate) * DAY_EFFECT_RATIO < Math.abs(raw)) {
      return "day effect — check normalized";
    }
  }
  if (shown.base && shown.base !== 0) {
    const pct = (shown.delta / shown.base) * 100;
    return `${sign(pct)}${fixed(pct, 0)}%`;
  }
  return "from zero";
}
