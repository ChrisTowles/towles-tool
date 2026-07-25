import { describe, expect, it } from "vitest";
import {
  DEFAULT_TELEMETRY_FILTERS,
  fmtDuration,
  focusShare,
  loadTelemetryFilters,
  type AttentionSummary,
} from "@/lib/telemetry";

describe("loadTelemetryFilters", () => {
  it("nothing stored falls back to all defaults", () => {
    expect(loadTelemetryFilters(null)).toEqual(DEFAULT_TELEMETRY_FILTERS);
  });

  it("restores a fully valid stored value", () => {
    const raw = JSON.stringify({ level: "ERROR", kind: "span", target: "tt_exec", query: "gh" });
    expect(loadTelemetryFilters(raw)).toEqual({
      level: "ERROR",
      kind: "span",
      target: "tt_exec",
      query: "gh",
    });
  });

  it("degrades an unknown level or kind to 'all' but keeps the valid fields", () => {
    const raw = JSON.stringify({ level: "LOUD", kind: "trace", target: "x", query: "q" });
    expect(loadTelemetryFilters(raw)).toEqual({
      level: "all",
      kind: "all",
      target: "x",
      query: "q",
    });
  });

  it("keeps an arbitrary target verbatim (targets are data-dependent)", () => {
    const raw = JSON.stringify({ target: "some::module::path" });
    expect(loadTelemetryFilters(raw).target).toBe("some::module::path");
  });

  it("degrades to defaults on malformed JSON", () => {
    expect(loadTelemetryFilters("{not json")).toEqual(DEFAULT_TELEMETRY_FILTERS);
  });

  it("degrades to defaults when the stored value is not an object", () => {
    expect(loadTelemetryFilters(JSON.stringify(["a", "b"]))).toEqual(DEFAULT_TELEMETRY_FILTERS);
    expect(loadTelemetryFilters(JSON.stringify("plain"))).toEqual(DEFAULT_TELEMETRY_FILTERS);
  });

  it("fills any missing field with its default", () => {
    expect(loadTelemetryFilters(JSON.stringify({ level: "WARN" }))).toEqual({
      level: "WARN",
      kind: "all",
      target: "all",
      query: "",
    });
  });
});

describe("fmtDuration", () => {
  it("drops to the coarsest two units that still say something", () => {
    expect(fmtDuration(8_000)).toBe("8s");
    // A real subprocess that took 400ms must not read as a flat zero.
    expect(fmtDuration(400)).toBe("<1s");
    expect(fmtDuration(0)).toBe("0s");
    expect(fmtDuration(90_000)).toBe("1m 30s");
    expect(fmtDuration(120_000)).toBe("2m");
    expect(fmtDuration(4 * 3_600_000 + 12 * 60_000)).toBe("4h 12m");
    // A whole number of hours drops the empty minutes rather than reading "4h 0m".
    expect(fmtDuration(4 * 3_600_000)).toBe("4h");
  });

  it("floors at zero rather than rendering a negative duration", () => {
    expect(fmtDuration(-5_000)).toBe("0s");
  });
});

describe("focusShare", () => {
  const base = {
    date: "2026-07-25",
    recordCount: 10,
    firstTs: null,
    lastTs: null,
    elapsedMs: 0,
    focus: {
      focusedMs: 0,
      sessionCount: 0,
      longestMs: 0,
      fragmentCount: 0,
      departures: 0,
      sessions: [],
    },
    actions: { total: 0, screenSwitches: 0, byScreen: [], byAction: [] },
    notifications: { fired: 0, skipped: 0 },
    machine: { spawnCount: 0, totalMs: 0, failures: 0, byExecutable: [] },
    hours: [],
  } satisfies AttentionSummary;

  it("is a whole percent of elapsed uptime", () => {
    const summary = { ...base, elapsedMs: 8_000, focus: { ...base.focus, focusedMs: 2_000 } };
    expect(focusShare(summary)).toBe(25);
  });

  it("is null on a day too empty for the ratio to mean anything", () => {
    expect(focusShare(base)).toBeNull();
  });

  /** Focus stretches are clamped to the last record, so this shouldn't
   * happen — but a clock jump inside the log must not render "104%". */
  it("clamps above 100 rather than reporting an impossible share", () => {
    const summary = { ...base, elapsedMs: 1_000, focus: { ...base.focus, focusedMs: 5_000 } };
    expect(focusShare(summary)).toBe(100);
  });
});
