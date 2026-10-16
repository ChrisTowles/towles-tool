import { describe, expect, it } from "vitest";
import { patchRows } from "./diff-view";

describe("patchRows", () => {
  it("numbers each side only on the lines that side has", () => {
    const rows = patchRows({ oldStart: 10, newStart: 12, lines: [" a", "-b", "+c", "+d", " e"] });
    expect(rows.map((r) => [r.kind, r.oldNo, r.newNo, r.text])).toEqual([
      ["ctx", 10, 12, "a"],
      ["del", 11, null, "b"],
      ["add", null, 13, "c"],
      ["add", null, 14, "d"],
      ["ctx", 12, 15, "e"],
    ]);
  });
});
