import { describe, expect, it } from "vitest";
import { notePaneKey, onPromptSubmit, typedSince } from "./prompt-submit";

describe("prompt submit signal", () => {
  it("reports Enter only, and remembers the latest keystroke per pane", () => {
    const seen: string[] = [];
    const off = onPromptSubmit((id) => seen.push(id));
    notePaneKey("a", false, 100);
    notePaneKey("a", true, 200);
    off();
    notePaneKey("a", true, 300);
    expect(seen).toEqual(["a"]);
    expect(typedSince("a", 250)).toBe(true);
    expect(typedSince("a", 300)).toBe(false);
    expect(typedSince("b", 0)).toBe(false);
  });
});
