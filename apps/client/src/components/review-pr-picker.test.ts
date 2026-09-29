import { describe, expect, it } from "vitest";

import { parsePrNumber } from "./review-pr-picker";

describe("parsePrNumber", () => {
  it("accepts a bare or #-prefixed number", () => {
    expect(parsePrNumber("12")).toBe(12);
    expect(parsePrNumber(" #647 ")).toBe(647);
  });

  it("rejects anything else", () => {
    expect(parsePrNumber("")).toBeNull();
    expect(parsePrNumber("#0")).toBeNull();
    expect(parsePrNumber("fix 12")).toBeNull();
    expect(parsePrNumber("12a")).toBeNull();
  });
});
