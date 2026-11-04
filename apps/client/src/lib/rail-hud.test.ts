import { describe, expect, it } from "vitest";
import { HUD_NOTE_MS, hudTextAt, noteIsFresh } from "@/lib/rail-hud";

describe("noteIsFresh", () => {
  const note = { text: "Deleted", tone: "ok" as const, at: 1000 };

  it("holds a note until it ages out", () => {
    expect(noteIsFresh(note, 1000 + HUD_NOTE_MS - 1)).toBe(true);
    expect(noteIsFresh(note, 1000 + HUD_NOTE_MS)).toBe(false);
  });

  it("is false with no note", () => {
    expect(noteIsFresh(null, 0)).toBe(false);
  });
});

describe("hudTextAt", () => {
  it("reads the nearest declared description", () => {
    const el = {
      closest: (sel: string) =>
        sel === "[data-hud]" ? { getAttribute: () => "open Files" } : null,
    };
    expect(hudTextAt(el as unknown as EventTarget)).toBe("open Files");
  });

  it("is null for a target that isn't an element", () => {
    expect(hudTextAt(null)).toBe(null);
    expect(hudTextAt({} as EventTarget)).toBe(null);
  });
});
