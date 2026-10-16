import { describe, expect, it } from "vitest";
import { fmtDiffLines, fmtDuration, fmtElapsed, fmtTokens } from "./format";

describe("fmtTokens", () => {
  it("abbreviates to K and M", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(950)).toBe("950");
    expect(fmtTokens(53_159)).toBe("53K");
    expect(fmtTokens(412_000)).toBe("412K");
    expect(fmtTokens(1_000_000)).toBe("1M");
    expect(fmtTokens(1_500_000)).toBe("1.5M");
  });

  it("promotes to M on the rounded value, never reading '1000K'", () => {
    expect(fmtTokens(999_499)).toBe("999K");
    expect(fmtTokens(999_500)).toBe("1M");
    expect(fmtTokens(999_999)).toBe("1M");
  });

  it("drops a trailing .0 after rounding", () => {
    expect(fmtTokens(1_020_000)).toBe("1M");
    expect(fmtTokens(1_049_999)).toBe("1M");
    expect(fmtTokens(1_550_000)).toBe("1.6M");
  });
});

describe("fmtDiffLines", () => {
  it("keeps every digit of a reviewable change", () => {
    expect(fmtDiffLines(0)).toBe("0");
    expect(fmtDiffLines(57)).toBe("57");
    expect(fmtDiffLines(2_347)).toBe("2347");
    expect(fmtDiffLines(9_999)).toBe("9999");
  });

  it("abbreviates past 10,000, where the digits stop meaning anything", () => {
    expect(fmtDiffLines(10_000)).toBe("10K");
    expect(fmtDiffLines(62_512)).toBe("62.5K");
    expect(fmtDiffLines(99_949)).toBe("99.9K");
  });

  it("drops the fraction once a tenth of a K is under a pixel of meaning", () => {
    expect(fmtDiffLines(123_456)).toBe("123K");
    expect(fmtDiffLines(999_499)).toBe("999K");
  });

  it("promotes to M on the rounded value, never reading '1000K'", () => {
    expect(fmtDiffLines(999_500)).toBe("1M");
    expect(fmtDiffLines(1_234_567)).toBe("1.2M");
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

describe("fmtElapsed", () => {
  it("renders a clock, adding hours only when needed", () => {
    expect(fmtElapsed(4_000)).toBe("0:04");
    expect(fmtElapsed(200_000)).toBe("3:20");
    expect(fmtElapsed(3_750_000)).toBe("1:02:30");
    expect(fmtElapsed(-5_000)).toBe("0:00");
  });
});
