import { beforeEach, describe, expect, it } from "vitest";
import {
  clearViewStates,
  recallViewState,
  rememberViewState,
  viewStateCount,
  viewStateKey,
} from "./editor-view-state";

describe("editor view-state store", () => {
  beforeEach(clearViewStates);

  it("hands back what it was given, per checkout-qualified file", () => {
    const a = viewStateKey("/repo/one", "src/main.rs");
    const b = viewStateKey("/repo/two", "src/main.rs");
    rememberViewState(a, { line: 40 });
    rememberViewState(b, { line: 7 });
    expect(recallViewState(a)).toEqual({ line: 40 });
    expect(recallViewState(b)).toEqual({ line: 7 });
  });

  it("returns null for a file it has never seen", () => {
    expect(recallViewState(viewStateKey("/repo", "unseen.ts"))).toBeNull();
  });

  it("evicts the least recently used file once full", () => {
    for (let i = 0; i < 100; i += 1) rememberViewState(`f${i}`, i);
    expect(recallViewState("f0")).toBe(0);
    rememberViewState("overflow", "new");
    expect(viewStateCount()).toBe(100);
    expect(recallViewState("f0")).toBe(0);
    expect(recallViewState("f1")).toBeNull();
  });

  it("re-remembering a file replaces its state without growing the store", () => {
    rememberViewState("f", 1);
    rememberViewState("f", 2);
    expect(viewStateCount()).toBe(1);
    expect(recallViewState("f")).toBe(2);
  });
});
