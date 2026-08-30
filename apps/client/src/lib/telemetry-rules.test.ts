import { describe, expect, it } from "vitest";
import type { RuleScore } from "./telemetry";
import {
  fmtRuleValue,
  fmtThreshold,
  ruleDetail,
  ruleState,
  shortDay,
  sparklineMax,
} from "./telemetry-rules";

function score(over: Partial<RuleScore>): RuleScore {
  return {
    id: "gh",
    label: "gh exits clean",
    kind: "share",
    threshold: 95,
    today: 100,
    failing: false,
    population: 12,
    series: [],
    failingSince: null,
    ...over,
  };
}

describe("ruleState", () => {
  it("is empty with no population, whatever the threshold", () => {
    expect(ruleState(score({ today: null }))).toBe("empty");
  });

  it("trusts the backend's failing flag", () => {
    expect(ruleState(score({ today: 40, failing: true }))).toBe("failing");
  });

  it("is near within 5 points on the passing side, in either direction", () => {
    expect(ruleState(score({ today: 97 }))).toBe("near");
    expect(ruleState(score({ today: 95 }))).toBe("near");
    expect(ruleState(score({ today: 100 }))).toBe("passing");
    expect(ruleState(score({ kind: "count", threshold: 30, today: 27 }))).toBe("near");
    expect(ruleState(score({ kind: "count", threshold: 30, today: 10 }))).toBe("passing");
  });

  it("calls a perfect score passing even on a zero-margin threshold", () => {
    expect(ruleState(score({ kind: "count", threshold: 0, today: 0 }))).toBe("passing");
    expect(ruleState(score({ threshold: 100, today: 100 }))).toBe("passing");
    expect(ruleState(score({ kind: "count", threshold: 3, today: 1 }))).toBe("near");
  });
});

describe("formatting", () => {
  it("prints shares as rounded percentages and counts bare", () => {
    expect(fmtRuleValue("share", 46.4)).toBe("46%");
    expect(fmtRuleValue("count", 16)).toBe("16");
    expect(fmtRuleValue("share", null)).toBe("—");
  });

  it("states the threshold with the sign that marks the passing side", () => {
    expect(fmtThreshold("share", 95)).toBe("threshold ≥ 95%");
    expect(fmtThreshold("count", 30)).toBe("threshold ≤ 30");
  });

  it("prints a UTC day without drifting into the previous local day", () => {
    expect(shortDay("2026-08-19")).toMatch(/Aug 19/);
    expect(shortDay("bogus")).toBe("bogus");
  });

  it("reads no-data, failing-since, or the population", () => {
    expect(ruleDetail(score({ today: null }))).toBe("n = 0 — no data");
    expect(ruleDetail(score({ today: 40, failing: true, failingSince: "2026-08-19" }))).toMatch(
      /^threshold ≥ 95% · failing since Aug 19$/,
    );
    expect(ruleDetail(score({ today: 100, population: 12 }))).toBe("threshold ≥ 95% · n = 12");
  });
});

describe("sparklineMax", () => {
  it("is the full percentage range for a share and fits the threshold for a count", () => {
    expect(sparklineMax(score({}))).toBe(100);
    const quiet = score({ kind: "count", threshold: 30, series: [] });
    expect(sparklineMax(quiet)).toBe(30);
    const loud = score({
      kind: "count",
      threshold: 30,
      series: [{ day: "2026-08-30", score: 48, population: 48 }],
    });
    expect(sparklineMax(loud)).toBe(48);
    expect(sparklineMax(score({ kind: "count", threshold: 0 }))).toBe(1);
  });
});
