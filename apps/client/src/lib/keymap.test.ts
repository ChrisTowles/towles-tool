import { describe, expect, it } from "vitest";
import { pcEditCommand } from "./keymap";

const ctrl = (key: string, extra: Partial<KeyboardEvent> = {}) => ({
  key,
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
});

describe("pcEditCommand", () => {
  it("maps the PC editing chords inside a text field", () => {
    expect(pcEditCommand(ctrl("c"), true, false)).toBe("copy");
    expect(pcEditCommand(ctrl("x"), true, false)).toBe("cut");
    expect(pcEditCommand(ctrl("a"), true, false)).toBe("selectAll");
    expect(pcEditCommand(ctrl("z"), true, false)).toBe("undo");
    expect(pcEditCommand(ctrl("y"), true, false)).toBe("redo");
    expect(pcEditCommand(ctrl("Z", { shiftKey: true }), true, false)).toBe("redo");
  });

  it("copies a page selection but edits nothing outside a field", () => {
    expect(pcEditCommand(ctrl("c"), false, true)).toBe("copy");
    expect(pcEditCommand(ctrl("c"), false, false)).toBeNull();
    expect(pcEditCommand(ctrl("x"), false, true)).toBeNull();
    expect(pcEditCommand(ctrl("a"), false, true)).toBeNull();
  });

  // Ctrl+V is the native monitor's (⌘V); anything with ⌘ or ⌥ is not a PC chord.
  it("leaves paste and every other chord alone", () => {
    expect(pcEditCommand(ctrl("v"), true, false)).toBeNull();
    expect(pcEditCommand(ctrl("k"), true, false)).toBeNull();
    expect(pcEditCommand(ctrl("c", { metaKey: true }), true, false)).toBeNull();
    expect(pcEditCommand(ctrl("c", { altKey: true }), true, false)).toBeNull();
    expect(pcEditCommand({ ...ctrl("c"), ctrlKey: false }, true, false)).toBeNull();
  });
});
