import { describe, expect, it } from "vitest";
import { archiveHours, splitArchiveHours } from "./auto-archive";

describe("auto-archive hours", () => {
  it("shows whole days as days, anything else as hours", () => {
    expect(splitArchiveHours(168)).toEqual({ amount: 7, unit: "days" });
    expect(splitArchiveHours(36)).toEqual({ amount: 36, unit: "hours" });
  });

  it("stores hours either way, never below one", () => {
    expect(archiveHours(3, "days")).toBe(72);
    expect(archiveHours(5, "hours")).toBe(5);
    expect(archiveHours(0, "days")).toBe(24);
    expect(archiveHours(2.7, "hours")).toBe(2);
  });

  it("round-trips", () => {
    for (const h of [1, 23, 24, 48, 100, 720]) {
      const { amount, unit } = splitArchiveHours(h);
      expect(archiveHours(amount, unit)).toBe(h);
    }
  });
});
