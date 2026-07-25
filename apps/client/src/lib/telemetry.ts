import { invoke } from "@/lib/tauri";

/**
 * Client-side bridge to the Telemetry screen (the Rust `tt-telemetry` crate,
 * surfaced via `crates-tauri/tt-app/src/telemetry.rs`). Reads the on-disk
 * event log fresh on every call — no server-side cache, unlike Claude
 * Sessions — since the log is small and the screen refreshes on a manual
 * button and on regaining focus rather than needing to survive rapid
 * re-renders.
 */

export type TelemetryRecord = {
  ts: string;
  /** `"event"` or `"span"`. */
  kind: string;
  level: string;
  target: string;
  name: string;
  /** The worktree/task scope that produced this record, if any. */
  ttTask: string | null;
  /** The git commit SHA the running binary was built from, if resolvable. */
  ttBuildSha: string | null;
  /** Present only on `kind: "span"` records. */
  durationMs: number | null;
  /** Every other field on the line. */
  fields: Record<string, unknown>;
  /** The original JSON line, verbatim. */
  raw: string;
};

/** Dates with a log file on disk, newest first. */
export const telemetryDays = () => invoke<string[]>("telemetry_days");

/** One day's records, in the order they were written. */
export const telemetryEvents = (date: string) =>
  invoke<TelemetryRecord[]>("telemetry_events", { date });

/**
 * One day's attention picture, aggregated by `tt-telemetry`'s `summarize`
 * (see `crates/tt-telemetry/src/attention.rs` for what each number means and
 * how focus stretches are paired). Deliberately a separate command rather
 * than a `useMemo` over the records `telemetryEvents` already returns: an
 * actively-used day runs to 75,000+ records, and aggregating in Rust turns
 * that into a few hundred bytes over IPC.
 */
export type AttentionSummary = {
  date: string;
  recordCount: number;
  firstTs: string | null;
  lastTs: string | null;
  /** Wall-clock between the first and last record — the app's uptime, which
   * focused time is a share of. */
  elapsedMs: number;
  focus: {
    focusedMs: number;
    sessionCount: number;
    longestMs: number;
    /** Stretches under two minutes: glances, not work. */
    fragmentCount: number;
    /** Times focus left the window — context switches away from the app. */
    departures: number;
    sessions: FocusSession[];
  };
  actions: {
    total: number;
    /** In-app screen changes, distinct from `focus.departures`. */
    screenSwitches: number;
    byScreen: Count[];
    byAction: Count[];
  };
  notifications: { fired: number; skipped: number };
  machine: {
    spawnCount: number;
    /** Summed span durations; concurrent spawns overlap, so this can exceed
     * `elapsedMs`. */
    totalMs: number;
    failures: number;
    byExecutable: { name: string; count: number; totalMs: number }[];
  };
  /** Always 24 entries, `hour` in local time — empty hours included so the
   * chart shows real gaps instead of compressing them away. */
  hours: { hour: number; focusedMs: number; actions: number; spawns: number }[];
};

export type FocusSession = {
  start: string;
  end: string;
  durationMs: number;
  /** The app exited (or the day ended) still focused, so this stretch is a
   * lower bound rather than a measurement. */
  openEnded: boolean;
};

export type Count = { key: string; count: number };

/** One day's attention picture. */
export const telemetryAttention = (date: string) =>
  invoke<AttentionSummary>("telemetry_attention", { date });

/**
 * `4h 12m` / `12m 30s` / `8s` — a duration at the coarsest two units that
 * still say something. Distinct from `fmtElapsed`'s `1:02:30` clock, which
 * reads as a stopwatch; these are day-scale totals where "4h 12m" is the
 * shape the eye wants and the seconds are noise.
 *
 * Anything non-zero under a second is `<1s`, never `0s` — the executable
 * breakdown lists real subprocesses that really did run, and rendering their
 * total as a flat zero reads as "this didn't happen".
 */
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

/** `focusedMs` as a whole-percent share of `elapsedMs`, or null when the day
 * is too empty for the ratio to mean anything. */
export function focusShare(summary: AttentionSummary): number | null {
  if (summary.elapsedMs <= 0) return null;
  return Math.min(100, Math.round((summary.focus.focusedMs / summary.elapsedMs) * 100));
}

export const LEVELS = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"] as const;
export type LevelFilter = "all" | (typeof LEVELS)[number];
export type KindFilter = "all" | "event" | "span";

/**
 * The Log tab's filter selections, persisted across screen switches and app
 * restarts (`tt-telemetry-filters`, the same localStorage idiom as the
 * workspace tab state). The day picker is deliberately *not* here — a stale
 * date is more confusing than useful, so it resets to the newest day each
 * visit.
 */
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

/**
 * Restore persisted Log-tab filters from a raw localStorage string, degrading
 * any missing or malformed field to its default rather than throwing — a
 * corrupt value can never break the screen.
 *
 * Pure (callers pass the raw string) so it can be unit tested, mirroring
 * `loadWorkspaceTabs`. `target` is kept verbatim since valid targets are
 * data-dependent (they vary by day) and can't be validated against a fixed
 * set here; the screen falls it back to "all" when the loaded day has no such
 * target.
 */
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
