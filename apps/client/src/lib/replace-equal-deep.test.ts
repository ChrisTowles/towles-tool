import { describe, expect, it } from "vitest";
import { replaceEqualDeep } from "./replace-equal-deep";

describe("replaceEqualDeep", () => {
  it("returns prev when the trees are deep-equal", () => {
    const prev = { a: [1, { b: 2 }], c: "x" };
    expect(replaceEqualDeep(prev, structuredClone(prev))).toBe(prev);
  });

  it("keeps unchanged subtrees and replaces only the changed path", () => {
    const prev = {
      repos: [
        { id: "a", s: [1] },
        { id: "b", s: [2] },
      ],
      ts: 1,
    };
    const next = {
      repos: [
        { id: "a", s: [1] },
        { id: "b", s: [3] },
      ],
      ts: 1,
    };
    const out = replaceEqualDeep(prev, next);
    expect(out).not.toBe(prev);
    expect(out.repos).not.toBe(prev.repos);
    expect(out.repos[0]).toBe(prev.repos[0]);
    expect(out.repos[1]).not.toBe(prev.repos[1]);
    expect(out).toEqual(next);
  });

  it("treats a length change as a change but still shares the common items", () => {
    const prev = [{ a: 1 }, { a: 2 }];
    const out = replaceEqualDeep(prev, [{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(prev[1]);
    const shrunk = replaceEqualDeep(prev, [{ a: 1 }]);
    expect(shrunk).toHaveLength(1);
    expect(shrunk[0]).toBe(prev[0]);
  });

  it("sees a dropped or added key", () => {
    const prev = { a: 1, b: 2 };
    expect(replaceEqualDeep(prev, { a: 1 })).toEqual({ a: 1 });
    expect(replaceEqualDeep(prev, { a: 1 })).not.toBe(prev);
  });

  it("does not confuse an explicit undefined with a missing key", () => {
    const prev = { a: 1 };
    const next = { a: 1, b: undefined };
    expect(replaceEqualDeep(prev, next)).not.toBe(prev);
  });

  it("returns next for mismatched kinds and primitives", () => {
    expect(replaceEqualDeep({ a: 1 }, [1])).toEqual([1]);
    expect(replaceEqualDeep(null, { a: 1 })).toEqual({ a: 1 });
    expect(replaceEqualDeep(1, 2)).toBe(2);
    expect(replaceEqualDeep(undefined, "s")).toBe("s");
  });

  it("handles null values inside objects", () => {
    const prev = { a: null, b: { c: null } };
    expect(replaceEqualDeep(prev, { a: null, b: { c: null } })).toBe(prev);
  });
});
