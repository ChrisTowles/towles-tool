import { describe, expect, it } from "vitest";
import {
  DEFAULT_TELEMETRY_FILTERS,
  effectiveFilters,
  filterLabel,
  fmtCell,
  fmtDuration,
  focusShare,
  loadTelemetryFilters,
  nearestRange,
  numericColumns,
  resultCaption,
  type AttentionSummary,
  type Filter,
  type QueryResult,
} from "@/lib/telemetry";

describe("loadTelemetryFilters", () => {
  it("nothing stored falls back to all defaults", () => {
    expect(loadTelemetryFilters(null)).toEqual(DEFAULT_TELEMETRY_FILTERS);
  });

  it("restores a fully valid stored value", () => {
    const stored = {
      kind: "span",
      days: 7,
      filters: [{ field: "durationMs", op: "gt", value: "2000" }],
      query: "gh",
    };
    expect(loadTelemetryFilters(JSON.stringify(stored))).toEqual(stored);
  });

  it("degrades an unknown kind or range to its default but keeps the valid fields", () => {
    const raw = JSON.stringify({ kind: "trace", days: 5, query: "q" });
    expect(loadTelemetryFilters(raw)).toEqual({ kind: "all", days: 1, filters: [], query: "q" });
  });

  it("drops a malformed filter and keeps the rest", () => {
    const raw = JSON.stringify({
      filters: [
        { field: "level", op: "eq", value: "WARN" },
        { field: "level", op: "like", value: "x" },
        { field: "", op: "eq", value: "x" },
        "not a filter",
        { field: "outcome", op: "neq" },
      ],
    });
    expect(loadTelemetryFilters(raw).filters).toEqual([
      { field: "level", op: "eq", value: "WARN" },
    ]);
  });

  it("degrades to defaults on malformed JSON", () => {
    expect(loadTelemetryFilters("{not json")).toEqual(DEFAULT_TELEMETRY_FILTERS);
  });

  it("degrades to defaults when the stored value is not an object", () => {
    expect(loadTelemetryFilters(JSON.stringify(["a", "b"]))).toEqual(DEFAULT_TELEMETRY_FILTERS);
    expect(loadTelemetryFilters(JSON.stringify("plain"))).toEqual(DEFAULT_TELEMETRY_FILTERS);
  });

  it("fills any missing field with its default", () => {
    expect(loadTelemetryFilters(JSON.stringify({ kind: "event" }))).toEqual({
      kind: "event",
      days: 1,
      filters: [],
      query: "",
    });
  });
});

describe("effectiveFilters", () => {
  it("prepends the kind chip as an eq predicate only when it is narrowed", () => {
    const f: Filter[] = [{ field: "level", op: "eq", value: "WARN" }];
    expect(effectiveFilters("all", f)).toBe(f);
    expect(effectiveFilters("span", f)).toEqual([{ field: "kind", op: "eq", value: "span" }, ...f]);
  });
});

describe("nearestRange", () => {
  it("snaps up to the next range chip and caps at a fortnight", () => {
    expect(nearestRange(1)).toBe(1);
    expect(nearestRange(2)).toBe(3);
    expect(nearestRange(7)).toBe(7);
    expect(nearestRange(30)).toBe(14);
  });
});

describe("filterLabel", () => {
  it("prints field, glyph, value", () => {
    expect(filterLabel({ field: "outcome", op: "neq", value: "ok" })).toBe("outcome ≠ ok");
    expect(filterLabel({ field: "message", op: "contains", value: "notify" })).toBe(
      "message contains notify",
    );
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

describe("query results", () => {
  const result: QueryResult = {
    columns: ["executable", "n", "avg_ms", "note"],
    rows: [
      ["gh", 3, 12.5, null],
      ["git", 1, null, null],
    ],
    truncated: false,
    elapsedMs: 41,
  };

  it("numericColumns: numbers and nulls right-align, all-null stays text", () => {
    expect(numericColumns(result)).toEqual([false, true, true, false]);
    expect(numericColumns({ ...result, rows: [] })).toEqual([false, false, false, false]);
  });

  it("resultCaption: count, elapsed, and the cap when it hit", () => {
    expect(resultCaption(result)).toBe("2 rows · 41 ms");
    expect(resultCaption({ ...result, rows: [result.rows[0]] })).toBe("1 row · 41 ms");
    expect(resultCaption({ ...result, truncated: true }, 2000)).toBe(
      "2 rows · 41 ms · first 2,000 only, narrow the query",
    );
  });

  it("fmtCell: null is spelled out, reals get two places", () => {
    expect(fmtCell(null)).toBe("null");
    expect(fmtCell(3)).toBe("3");
    expect(fmtCell(12.5)).toBe("12.50");
    expect(fmtCell("gh")).toBe("gh");
  });
});
