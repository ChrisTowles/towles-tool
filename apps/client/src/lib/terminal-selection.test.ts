import { describe, expect, it } from "vitest";
import {
  rowsHaveSelection,
  selectionGestureKey,
  selectionKindForDetail,
  shouldCopyOnSelect,
} from "./terminal-selection";

describe("selectionKindForDetail", () => {
  it("maps a double-click to a word selection", () => {
    expect(selectionKindForDetail(2)).toBe("word");
  });

  it("maps a triple (or higher) click to a line selection", () => {
    expect(selectionKindForDetail(3)).toBe("line");
    expect(selectionKindForDetail(5)).toBe("line");
  });

  it("treats a single click (or zero-detail synthetic event) as a drag", () => {
    expect(selectionKindForDetail(1)).toBe("drag");
    expect(selectionKindForDetail(0)).toBe("drag");
  });
});

describe("selectionGestureKey", () => {
  it("keys a word by column and row", () => {
    expect(selectionGestureKey("word", 4, 120)).toBe("word:4:120");
    expect(selectionGestureKey("word", 5, 120)).not.toBe(selectionGestureKey("word", 4, 120));
  });

  it("keys a line by row alone, so anywhere on the row is the same gesture", () => {
    expect(selectionGestureKey("line", 0, 120)).toBe(selectionGestureKey("line", 40, 120));
    expect(selectionGestureKey("line", 0, 121)).not.toBe(selectionGestureKey("line", 0, 120));
  });
});

describe("shouldCopyOnSelect", () => {
  it("copies a produced selection only when the preference is enabled", () => {
    expect(shouldCopyOnSelect(true, "drag", null, null)).toBe(true);
    expect(shouldCopyOnSelect(true, "word", "word:1:2", null)).toBe(true);
    expect(shouldCopyOnSelect(true, "line", "line:2", null)).toBe(true);
    expect(shouldCopyOnSelect(false, "drag", null, null)).toBe(false);
  });

  it("never copies on a clear, even when enabled", () => {
    expect(shouldCopyOnSelect(true, "clear", null, null)).toBe(false);
    expect(shouldCopyOnSelect(false, "clear", null, null)).toBe(false);
  });

  // The regression this function exists for: `selectionKindForDetail` maps
  // every click past the second to `line`, so holding the mouse down over and
  // over used to re-take the clipboard on each press.
  it("does not re-copy a gesture that selected what the last copy already took", () => {
    expect(shouldCopyOnSelect(true, "line", "line:120", "line:120")).toBe(false);
    expect(shouldCopyOnSelect(true, "word", "word:4:120", "word:4:120")).toBe(false);
  });

  it("copies again once the gesture targets something new", () => {
    expect(shouldCopyOnSelect(true, "line", "line:121", "line:120")).toBe(true);
    expect(shouldCopyOnSelect(true, "word", "word:5:120", "word:4:120")).toBe(true);
    // A double-click after a triple-click on the same row is a real change.
    expect(shouldCopyOnSelect(true, "word", "word:4:120", "line:120")).toBe(true);
  });

  it("always copies a drag, whose range is new by construction", () => {
    expect(shouldCopyOnSelect(true, "drag", null, "line:120")).toBe(true);
    expect(shouldCopyOnSelect(true, "drag", null, null)).toBe(true);
  });
});

describe("rowsHaveSelection", () => {
  it("is true when any row carries a selection range", () => {
    expect(rowsHaveSelection([{ runs: undefined }, { sel: [1, 4] }] as never)).toBe(true);
  });

  it("is false when no row is selected", () => {
    expect(rowsHaveSelection([{}, {}])).toBe(false);
    expect(rowsHaveSelection([])).toBe(false);
  });
});
