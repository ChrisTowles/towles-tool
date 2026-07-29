import { describe, expect, it } from "vitest";
import { prChecksFailing, prNeedsYou, prTone } from "./pr-tone";

describe("prNeedsYou", () => {
  it("open PRs need you for failing checks or a review request", () => {
    expect(prNeedsYou({ state: "open", checks: "failing", reviewState: "none" })).toBe(true);
    expect(prNeedsYou({ state: "open", checks: "passing", reviewState: "review_requested" })).toBe(
      true,
    );
    expect(prNeedsYou({ state: "open", checks: "passing", reviewState: "none" })).toBe(false);
  });

  it("a PR that is no longer open needs nothing — merged or closed", () => {
    // The rail's attention strip used to keep closed-unmerged PRs on the
    // `state !== "merged"` test while the header and Cockpit scoped to open.
    for (const state of ["merged", "closed"]) {
      expect(prNeedsYou({ state, checks: "failing", reviewState: "review_requested" })).toBe(false);
      expect(prChecksFailing({ state, checks: "failing" })).toBe(false);
    }
  });
});

describe("prTone", () => {
  it("merged wins over everything", () => {
    expect(prTone({ state: "merged", checks: "failing" })).toBe("merged");
  });

  it("closed-unmerged reads as failed, whatever the checks said", () => {
    expect(prTone({ state: "closed", checks: "passing" })).toBe("failed");
  });

  it("open PRs follow the checks rollup", () => {
    expect(prTone({ state: "open", checks: "failing" })).toBe("failed");
    expect(prTone({ state: "open", checks: "passing" })).toBe("passing");
    expect(prTone({ state: "open", checks: "pending" })).toBe("running");
    expect(prTone({ state: "open", checks: "none" })).toBe("plain");
  });

  it("an unknown checks value degrades visibly as running, not neutral", () => {
    expect(prTone({ state: "open", checks: "queued" })).toBe("running");
  });
});
