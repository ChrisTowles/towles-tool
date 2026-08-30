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
  /** `process.pid`, kept so a span can be grouped with what it wrote. */
  pid: number | null;
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
export type KindFilter = "all" | "event" | "span";

/** Mirrors Rust's `tt_config::FilterOp`; the spelling is the wire format. */
export const FILTER_OPS = ["eq", "neq", "contains", "gt", "lt"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** One structured predicate — `tt_config::TelemetryFilter`. `field` is a base
 * column (`kind`, `level`, `target`, `name`, `ttTask`, `ttBuildSha`,
 * `durationMs`) or any key in `fields`. */
export type Filter = { field: string; op: FilterOp; value: string };

export const OP_GLYPH: Record<FilterOp, string> = {
  eq: "=",
  neq: "≠",
  contains: "contains",
  gt: ">",
  lt: "<",
};

/** `field op value`, as the chip prints it. */
export function filterLabel(f: Filter): string {
  return `${f.field} ${OP_GLYPH[f.op]} ${f.value}`;
}

/** Fields the Add-filter popover suggests; any key typed by hand works too. */
export const FILTER_FIELD_SUGGESTIONS = [
  "level",
  "target",
  "name",
  "message",
  "kind",
  "ttTask",
  "ttBuildSha",
  "durationMs",
  "process.executable.name",
  "outcome",
  "exit_code",
  "action",
  "screen",
] as const;

export const RANGE_DAYS = [1, 3, 7, 14] as const;
export type RangeDays = (typeof RANGE_DAYS)[number];

export type RecordPage = { records: TelemetryRecord[]; total: number };

/** The newest `limit` matches of the last `days` log files, filtered in Rust. */
export const telemetryRecords = (days: number, filters: Filter[], query: string, limit: number) =>
  invoke<RecordPage>("telemetry_records", { days, filters, query, limit });

/** The records written during the span that closed at `ts`, oldest first. */
export const telemetryTrace = (ts: string, day: string) =>
  invoke<TelemetryRecord[]>("telemetry_trace", { ts, day });

/** What a sibling tab hands the Log tab to pre-fill it. */
export type LogPreset = { days: number; filters: Filter[]; query?: string };

/** Persisted across screen switches and restarts. */
export type TelemetryFilters = {
  kind: KindFilter;
  days: RangeDays;
  filters: Filter[];
  query: string;
};

export const DEFAULT_TELEMETRY_FILTERS: TelemetryFilters = {
  kind: "all",
  days: 1,
  filters: [],
  query: "",
};

export const TELEMETRY_FILTERS_KEY = "tt-telemetry-filters";

const KIND_VALUES = new Set<string>(["all", "event", "span"]);
const OP_VALUES = new Set<string>(FILTER_OPS);

export function isFilter(value: unknown): value is Filter {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.field === "string" &&
    f.field.length > 0 &&
    typeof f.op === "string" &&
    OP_VALUES.has(f.op) &&
    typeof f.value === "string"
  );
}

export function isRangeDays(value: unknown): value is RangeDays {
  return typeof value === "number" && (RANGE_DAYS as readonly number[]).includes(value);
}

/** Every malformed field degrades to its default, so a corrupt value can never
 * break the screen; a malformed filter is dropped, the rest kept. */
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
    kind: typeof p.kind === "string" && KIND_VALUES.has(p.kind) ? (p.kind as KindFilter) : "all",
    days: isRangeDays(p.days) ? p.days : 1,
    filters: Array.isArray(p.filters) ? p.filters.filter(isFilter) : [],
    query: typeof p.query === "string" ? p.query : "",
  };
}

export function saveTelemetryFilters(filters: TelemetryFilters): void {
  localStorage.setItem(TELEMETRY_FILTERS_KEY, JSON.stringify(filters));
}

/** The filters the backend runs: the kind chip is one more `eq` predicate. */
export function effectiveFilters(kind: KindFilter, filters: Filter[]): Filter[] {
  return kind === "all" ? filters : [{ field: "kind", op: "eq", value: kind }, ...filters];
}

/** Snaps an arbitrary day count (a saved view's, a preset's) to the range chip. */
export function nearestRange(days: number): RangeDays {
  return RANGE_DAYS.find((d) => d >= days) ?? 14;
}
