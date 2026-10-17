import { describe, expect, it } from "vitest";
import { behindLabel, behindTooltip } from "./build-behind";

describe("behindLabel", () => {
  it("states how far main moved and what to do", () => {
    expect(behindLabel({ commits: 5, build: "b7dc674" })).toBe("main +5 · rebuild");
  });
});

describe("behindTooltip", () => {
  it("names the build and pluralises the commits", () => {
    expect(behindTooltip({ commits: 5, build: "b7dc674" })).toBe(
      "Built from b7dc674; origin/main has 5 newer commits. Rebuild with bun start.",
    );
    expect(behindTooltip({ commits: 1, build: "b7dc674" })).toContain("1 newer commit.");
  });
});
