import { describe, expect, it } from "vitest";
import { actionsToGoal, fmtShare, tierFor, type KeyboardDay } from "./keyboard-score";

const day = (shortcut: number, mouse: number, goalMet = false): KeyboardDay => ({
  date: "2026-07-25",
  shortcut,
  mouse,
  share: shortcut + mouse > 0 ? shortcut / (shortcut + mouse) : null,
  goalMet,
  idle: shortcut + mouse < 10,
  byShortcut: [],
});

describe("tierFor", () => {
  it("ranks a share", () => {
    expect(tierFor(0.95)).toBe("keyboard-native");
    expect(tierFor(0.75)).toBe("keyboard-first");
    expect(tierFor(0.6)).toBe("mixed");
    expect(tierFor(0.1)).toBe("mouse-first");
  });

  /** No bound actions yet is not the bottom rung — it's no rung. */
  it("has no rung for a day with nothing bound yet", () => {
    expect(tierFor(null)).toBeNull();
  });
});

describe("fmtShare", () => {
  it("renders a percentage, and an em dash for nothing", () => {
    expect(fmtShare(0.824)).toBe("82%");
    expect(fmtShare(0)).toBe("0%");
    expect(fmtShare(null)).toBe("—");
  });
});

describe("actionsToGoal", () => {
  /** Each further keyboard action raises both sides of the ratio, so 6/10
   * needs six more to reach 12/16 — not the two a naive "get to 75% of
   * today's ten" would suggest. */
  it("counts the keyboard actions that would flip the day", () => {
    expect(actionsToGoal(day(6, 4), 0.75, 10)).toBe(6);
  });

  /** A perfect but tiny day is short on volume, not on share. */
  it("falls back to the volume the goal needs", () => {
    expect(actionsToGoal(day(4, 0), 0.75, 10)).toBe(6);
  });

  it("is null once the day is won", () => {
    expect(actionsToGoal(day(20, 2, true), 0.75, 10)).toBeNull();
  });

  /** A day deep in the red still gets a real number, never a zero that reads
   * as "already there". */
  it("never returns less than one more action", () => {
    expect(actionsToGoal(day(0, 40), 0.75, 10)).toBeGreaterThan(1);
    expect(actionsToGoal(day(9, 1), 0.75, 10)).toBe(1);
  });
});
