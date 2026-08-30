import { describe, expect, it } from "vitest";
import type { BuildDelta, BuildSnapshot } from "./telemetry";
import {
  defaultPair,
  fmtDelta,
  fmtValue,
  loadBuildsPair,
  readOf,
  resolvePair,
  shortDay,
  verdict,
} from "./telemetry-builds";

const snap = (sha: string, day: string, recordCount: number): BuildSnapshot => ({
  sha,
  day,
  recordCount,
  measures: {
    ghCalls: 0,
    gitCalls: 0,
    claudeCalls: 0,
    ghFailurePct: null,
    gitFailurePct: null,
    subprocessWaitMs: 0,
    p95SpawnMs: 0,
    focusFlips: 0,
    needsYouFired: 0,
    needsYouSkipped: 0,
    uiActions: 0,
    warnErrorRecords: 0,
    focusedMs: 0,
  },
});

const delta = (over: Partial<BuildDelta>): BuildDelta => ({
  measure: "gh_calls",
  label: "gh calls",
  base: 100,
  other: 51,
  delta: -49,
  direction: "neutral",
  unit: "count",
  perHour: null,
  ...over,
});

describe("defaultPair", () => {
  it("takes the two newest substantial snapshots", () => {
    const pair = defaultPair([
      snap("c", "2026-08-30", 40),
      snap("b", "2026-08-29", 900),
      snap("a", "2026-08-28", 6000),
    ]);
    expect(pair).toEqual({
      base: { sha: "a", day: "2026-08-28" },
      other: { sha: "b", day: "2026-08-29" },
    });
  });

  it("falls back to any two when fewer than two are substantial", () => {
    expect(defaultPair([snap("c", "2026-08-30", 40), snap("b", "2026-08-29", 900)])).toEqual({
      base: { sha: "b", day: "2026-08-29" },
      other: { sha: "c", day: "2026-08-30" },
    });
    expect(defaultPair([snap("c", "2026-08-30", 40)])).toBeNull();
  });
});

describe("resolvePair", () => {
  const snapshots = [snap("b", "2026-08-29", 900), snap("a", "2026-08-28", 6000)];

  it("keeps a stored pair while both snapshots exist", () => {
    const stored = {
      base: { sha: "b", day: "2026-08-29" },
      other: { sha: "a", day: "2026-08-28" },
    };
    expect(resolvePair(stored, snapshots)).toBe(stored);
  });

  it("degrades to the default once a sha has rotated out", () => {
    const stored = {
      base: { sha: "z", day: "2026-08-10" },
      other: { sha: "a", day: "2026-08-28" },
    };
    expect(resolvePair(stored, snapshots)).toEqual(defaultPair(snapshots));
  });
});

describe("loadBuildsPair", () => {
  it("accepts only a pair of keys", () => {
    expect(loadBuildsPair(null)).toBeNull();
    expect(loadBuildsPair("nope")).toBeNull();
    expect(loadBuildsPair('{"base":{"sha":"a"}}')).toBeNull();
    expect(
      loadBuildsPair(
        '{"base":{"sha":"a","day":"2026-08-28"},"other":{"sha":"b","day":"2026-08-29"}}',
      ),
    ).toEqual({ base: { sha: "a", day: "2026-08-28" }, other: { sha: "b", day: "2026-08-29" } });
  });
});

describe("verdict", () => {
  it("follows the measure's direction, not the sign", () => {
    expect(verdict(-5, "lowerIsBetter")).toBe("better");
    expect(verdict(5, "lowerIsBetter")).toBe("worse");
    expect(verdict(5, "higherIsBetter")).toBe("better");
    expect(verdict(5, "neutral")).toBe("neutral");
    expect(verdict(0, "lowerIsBetter")).toBe("same");
    expect(verdict(null, "lowerIsBetter")).toBe("none");
  });
});

describe("formatting", () => {
  it("renders units and signed deltas", () => {
    expect(fmtValue(1234, "count")).toBe("1,234");
    expect(fmtValue(12.34, "count", true)).toBe("12.3/h");
    expect(fmtValue(50, "percent")).toBe("50.0%");
    expect(fmtValue(842, "ms")).toBe("842 ms");
    expect(fmtValue(4.25, "minutes")).toBe("4.3 min");
    expect(fmtValue(null, "count")).toBe("—");
    expect(fmtDelta(-49, "count")).toBe("−49");
    expect(fmtDelta(3, "count")).toBe("+3");
    expect(fmtDelta(-12.5, "percent")).toBe("−12.5 pt");
    expect(fmtDelta(0, "ms")).toBe("0");
  });

  it("shows the day, not a shifted local date", () => {
    expect(shortDay("2026-08-28")).toMatch(/Aug 28/);
  });
});

describe("readOf", () => {
  it("states the change and nothing more", () => {
    expect(readOf(delta({}), false)).toBe("−49%");
    expect(readOf(delta({ delta: 0, other: 100 }), false)).toBe("unchanged");
    expect(readOf(delta({ unit: "percent", base: 50, other: 1, delta: -49 }), false)).toBe("−98%");
    expect(readOf(delta({ unit: "percent", base: 50, other: 0, delta: -50 }), false)).toBe(
      "now zero",
    );
    expect(readOf(delta({ base: null, other: null, delta: null }), false)).toBe("no data");
  });

  it("flags a raw move the per-hour rate does not share", () => {
    const d = delta({ perHour: { base: 10, other: 10.2, delta: 0.2 } });
    expect(readOf(d, false)).toBe("day effect — check normalized");
    expect(readOf(d, true)).toBe("+2%");
  });

  it("names the withheld denominator in the normalized view", () => {
    const d = delta({ perHour: { base: null, other: 4, delta: null } });
    expect(readOf(d, true)).toBe("under 10 min focused");
  });
});
