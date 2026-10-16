import { describe, expect, it } from "vitest";
import { closeOnFalse, paneStyle, toggled } from "./helpers";
import { mockFn } from "./test-fixtures";

describe("toggled", () => {
  it("adds a missing value without touching the original", () => {
    const before = new Set(["a"]);
    const after = toggled(before, "b");
    expect([...after]).toEqual(["a", "b"]);
    expect([...before]).toEqual(["a"]);
  });

  it("removes a present value", () => {
    expect([...toggled(new Set(["a", "b"]), "a")]).toEqual(["b"]);
  });
});

describe("closeOnFalse", () => {
  it("fires only when the dialog reports closed", () => {
    const fn = mockFn();
    const handler = closeOnFalse(fn);
    handler(true);
    expect(fn).not.toHaveBeenCalled();
    handler(false);
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe("paneStyle", () => {
  it("renders a rect as percentages", () => {
    expect(paneStyle({ left: 0, top: 10, width: 50, height: 90 })).toEqual({
      left: "0%",
      top: "10%",
      width: "50%",
      height: "90%",
    });
  });
});
