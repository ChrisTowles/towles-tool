import { invoke } from "@/lib/tauri";

/** Reads the on-disk event log fresh on every call — no server-side cache. */

export type TelemetryRecord = {
  ts: string;
  kind: string;
  level: string;
  target: string;
  name: string;
  ttTask: string | null;
  ttBuildSha: string | null;
  durationMs: number | null;
  fields: Record<string, unknown>;
  raw: string;
};

/** Newest first. */
export const telemetryDays = () => invoke<string[]>("telemetry_days");

export const telemetryEvents = (date: string) =>
  invoke<TelemetryRecord[]>("telemetry_events", { date });

/** A separate command, not a `useMemo` over `telemetryEvents`: a busy day runs
 * to 75,000+ records, and aggregating in Rust makes that a few hundred bytes. */
export type AttentionSummary = {
  date: string;
  recordCount: number;
  firstTs: string | null;
  lastTs: string | null;
  elapsedMs: number;
  focus: {
    focusedMs: number;
    sessionCount: number;
    longestMs: number;
    /** Stretches under two minutes: glances, not work. */
    fragmentCount: number;
    departures: number;
    sessions: FocusSession[];
  };
  actions: {
    total: number;
    screenSwitches: number;
    byScreen: Count[];
    byAction: Count[];
  };
  notifications: { fired: number; skipped: number };
  machine: {
    spawnCount: number;
    /** Summed span durations; concurrent spawns overlap, so this can exceed `elapsedMs`. */
    totalMs: number;
    failures: number;
    byExecutable: { name: string; count: number; totalMs: number }[];
  };
  /** Always 24 local-time entries; empty hours included so the chart shows real gaps. */
  hours: { hour: number; focusedMs: number; actions: number; spawns: number }[];
};

export type FocusSession = {
  start: string;
  end: string;
  durationMs: number;
  /** Still focused when the app exited: a lower bound, not a measurement. */
  openEnded: boolean;
};

export type Count = { key: string; count: number };

export const telemetryAttention = (date: string) =>
  invoke<AttentionSummary>("telemetry_attention", { date });

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

/** Null when the day is too empty for the ratio to mean anything. */
export function focusShare(summary: AttentionSummary): number | null {
  if (summary.elapsedMs <= 0) return null;
  return Math.min(100, Math.round((summary.focus.focusedMs / summary.elapsedMs) * 100));
}

export const LEVELS = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"] as const;
export type LevelFilter = "all" | (typeof LEVELS)[number];
export type KindFilter = "all" | "event" | "span";

/** Persisted across screen switches and restarts. The day picker is deliberately
 * *not* here — a stale date confuses, so it resets to the newest day each visit. */
export type TelemetryFilters = {
  level: LevelFilter;
  kind: KindFilter;
  target: string;
  query: string;
};

export const DEFAULT_TELEMETRY_FILTERS: TelemetryFilters = {
  level: "all",
  kind: "all",
  target: "all",
  query: "",
};

export const TELEMETRY_FILTERS_KEY = "tt-telemetry-filters";

const LEVEL_VALUES = new Set<string>(["all", ...LEVELS]);
const KIND_VALUES = new Set<string>(["all", "event", "span"]);

/** Every malformed field degrades to its default, so a corrupt value can never
 * break the screen. `target` is kept verbatim — valid targets vary by day, and
 * the screen falls back to "all" when the loaded day has no such target. */
export function loadTelemetryFilters(raw: string | null): TelemetryFilters {
  if (raw === null) return DEFAULT_TELEMETRY_FILTERS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_TELEMETRY_FILTERS;
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_TELEMETRY_FILTERS;
  const p = parsed as Record<string, unknown>;
  return {
    level:
      typeof p.level === "string" && LEVEL_VALUES.has(p.level) ? (p.level as LevelFilter) : "all",
    kind: typeof p.kind === "string" && KIND_VALUES.has(p.kind) ? (p.kind as KindFilter) : "all",
    target: typeof p.target === "string" ? p.target : "all",
    query: typeof p.query === "string" ? p.query : "",
  };
}

export function saveTelemetryFilters(filters: TelemetryFilters): void {
  localStorage.setItem(TELEMETRY_FILTERS_KEY, JSON.stringify(filters));
}
