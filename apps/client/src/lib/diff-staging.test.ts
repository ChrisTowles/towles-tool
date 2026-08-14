import { describe, expect, it } from "vitest";
import {
  folderStageState,
  revertLineRange,
  revertRangeMappings,
  stageCheckState,
  stageToggleAction,
  type RangeLite,
} from "./diff-staging";

// Ranges mirror Monaco's LineRange: 1-based start, exclusive end.
const range = (start: number, endExclusive: number) => ({
  startLineNumber: start,
  endLineNumberExclusive: endExclusive,
});

describe("revertLineRange", () => {
  it("puts a modified block back to the original lines", () => {
    expect(revertLineRange("a\nb\nc\n", "a\nB\nc\n", range(2, 3), range(2, 3))).toBe("a\nb\nc\n");
  });

  it("removes an inserted block (empty original range)", () => {
    expect(revertLineRange("a\nc\n", "a\nb\nc\n", range(2, 2), range(2, 3))).toBe("a\nc\n");
  });

  it("re-inserts a deleted block (empty modified range)", () => {
    expect(revertLineRange("a\nb\nc\n", "a\nc\n", range(2, 3), range(2, 2))).toBe("a\nb\nc\n");
  });

  it("handles uneven block sizes", () => {
    expect(revertLineRange("a\nx\ny\nz\nd\n", "a\nQ\nd\n", range(2, 5), range(2, 3))).toBe(
      "a\nx\ny\nz\nd\n",
    );
  });

  it("re-inserts a deleted final line that had no trailing newline", () => {
    // HEAD "a\nx" (no trailing newline), index deleted the "x" line.
    expect(revertLineRange("a\nx", "a\n", range(2, 3), range(2, 2))).toBe("a\nx");
  });

  it("removes an added final line that has no trailing newline", () => {
    expect(revertLineRange("a\n", "a\nx", range(2, 2), range(2, 3))).toBe("a\n");
  });

  it("restores a removed trailing newline", () => {
    // Index rewrote the last line without its newline; HEAD had one.
    expect(revertLineRange("a\nb\n", "a\nB", range(2, 3), range(2, 3))).toBe("a\nb\n");
  });

  it("reverts at the top of the file", () => {
    expect(revertLineRange("a\nb\n", "X\nb\n", range(1, 2), range(1, 2))).toBe("a\nb\n");
  });

  it("reverts the whole content of a one-sided file", () => {
    // A staged new file: original (HEAD) is empty, everything is an insertion.
    expect(revertLineRange("", "new\n", range(1, 1), range(1, 2))).toBe("");
  });
});

// Monaco's Range: 1-based lines and columns, end-exclusive column.
const charRange = (sl: number, sc: number, el: number, ec: number): RangeLite => ({
  startLineNumber: sl,
  startColumn: sc,
  endLineNumber: el,
  endColumn: ec,
});

describe("revertRangeMappings", () => {
  it("reverts one whole-line mapping like the line-range revert", () => {
    // The hunk toolbar's shape: one mapping spanning full lines.
    const next = revertRangeMappings("a\nb\nc\n", "a\nB\nc\n", [
      { originalRange: charRange(2, 1, 3, 1), modifiedRange: charRange(2, 1, 3, 1) },
    ]);
    expect(next).toBe("a\nb\nc\n");
  });

  it("reverts only the mapped spans, not the lines between them", () => {
    // Three changed lines; only the first and third are selected — the
    // outer hull would also revert "TWO", losing a staged change.
    const next = revertRangeMappings("one\ntwo\nthree\n", "ONE\nTWO\nTHREE\n", [
      { originalRange: charRange(1, 1, 1, 4), modifiedRange: charRange(1, 1, 1, 4) },
      { originalRange: charRange(3, 1, 3, 6), modifiedRange: charRange(3, 1, 3, 6) },
    ]);
    expect(next).toBe("one\nTWO\nthree\n");
  });

  it("re-inserts a deleted span at an empty modified range", () => {
    const next = revertRangeMappings("a\nb\nc\n", "a\nc\n", [
      { originalRange: charRange(2, 1, 3, 1), modifiedRange: charRange(2, 1, 2, 1) },
    ]);
    expect(next).toBe("a\nb\nc\n");
  });

  it("removes an inserted span at an empty original range", () => {
    const next = revertRangeMappings("a\nc\n", "a\nb\nc\n", [
      { originalRange: charRange(2, 1, 2, 1), modifiedRange: charRange(2, 1, 3, 1) },
    ]);
    expect(next).toBe("a\nc\n");
  });

  it("clamps a range that ends past the last line", () => {
    // No trailing newline: Monaco spells "to EOF" as one line past the end.
    const next = revertRangeMappings("a\nx", "a\nX", [
      { originalRange: charRange(2, 1, 3, 1), modifiedRange: charRange(2, 1, 3, 1) },
    ]);
    expect(next).toBe("a\nx");
  });

  it("applies mappings in document order regardless of input order", () => {
    const mappings = [
      { originalRange: charRange(3, 1, 3, 2), modifiedRange: charRange(3, 1, 3, 2) },
      { originalRange: charRange(1, 1, 1, 2), modifiedRange: charRange(1, 1, 1, 2) },
    ];
    expect(revertRangeMappings("a\nb\nc\n", "X\nb\nY\n", mappings)).toBe("a\nb\nc\n");
    expect(revertRangeMappings("a\nb\nc\n", "X\nb\nY\n", mappings.toReversed())).toBe("a\nb\nc\n");
  });
});

describe("stage checkbox states", () => {
  it("maps the three file states", () => {
    expect(stageCheckState({ staged: false, unstaged: true })).toBe(false);
    expect(stageCheckState({ staged: true, unstaged: false })).toBe(true);
    expect(stageCheckState({ staged: true, unstaged: true })).toBe("indeterminate");
  });

  it("stages anything not fully staged, unstages the rest", () => {
    expect(stageToggleAction({ staged: false, unstaged: true })).toBe("stage");
    expect(stageToggleAction({ staged: true, unstaged: true })).toBe("stage");
    expect(stageToggleAction({ staged: true, unstaged: false })).toBe("unstage");
  });

  it("aggregates a folder", () => {
    const full = { staged: true, unstaged: false };
    const none = { staged: false, unstaged: true };
    expect(folderStageState([full, full])).toBe(true);
    expect(folderStageState([full, none])).toBe("indeterminate");
    expect(folderStageState([none, none])).toBe(false);
    expect(folderStageState([])).toBe(false);
  });
});
