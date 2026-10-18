import { describe, expect, it } from "vitest";
import { cardMotion, SKELETON_MIN_SHOW_MS, skeletonHoldMs, stripMotion } from "./motion-presets";

describe("presets", () => {
  it("keep durations inside the calm band", () => {
    for (const p of [stripMotion, cardMotion]) {
      expect(p.transition.duration).toBeGreaterThanOrEqual(0.12);
      expect(p.transition.duration).toBeLessThanOrEqual(0.22);
    }
  });
});

describe("skeletonHoldMs", () => {
  it("is 0 when no skeleton showed", () => {
    expect(skeletonHoldMs(null, 5000)).toBe(0);
  });
  it("holds the remainder of the minimum", () => {
    expect(skeletonHoldMs(1000, 1100)).toBe(SKELETON_MIN_SHOW_MS - 100);
  });
  it("releases after the minimum", () => {
    expect(skeletonHoldMs(1000, 1000 + SKELETON_MIN_SHOW_MS)).toBe(0);
  });
});
