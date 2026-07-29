import { describe, expect, it } from "vitest";
import {
  clampEditorFontSize,
  DEFAULT_EDITOR_FONT_SIZE,
  MAX_EDITOR_FONT_SIZE,
  MIN_EDITOR_FONT_SIZE,
} from "./editor-prefs";

describe("clampEditorFontSize", () => {
  it("keeps a size in range, rounding a fractional one", () => {
    expect(clampEditorFontSize(14)).toBe(14);
    expect(clampEditorFontSize(13.4)).toBe(13);
  });

  it("clamps past either bound — the settings file is hand-editable", () => {
    expect(clampEditorFontSize(2)).toBe(MIN_EDITOR_FONT_SIZE);
    expect(clampEditorFontSize(400)).toBe(MAX_EDITOR_FONT_SIZE);
  });

  it("falls back to the default for a value that isn't a number at all", () => {
    expect(clampEditorFontSize(Number.NaN)).toBe(DEFAULT_EDITOR_FONT_SIZE);
    expect(clampEditorFontSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_EDITOR_FONT_SIZE);
  });
});
