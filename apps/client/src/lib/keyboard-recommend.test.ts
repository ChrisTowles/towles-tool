import { describe, expect, it } from "vitest";
import { MAX_RECOMMENDATIONS, recommend } from "./keyboard-recommend";
import type { KeyboardScore, ShortcutSplit } from "./keyboard-score";

const score = (byShortcut: ShortcutSplit[], windowNeedsYou = 0): KeyboardScore => {
  const today = {
    date: "2026-09-16",
    shortcut: 0,
    mouse: 0,
    share: null,
    goalMet: false,
    idle: true,
    byShortcut: [],
    needsYou: 0,
  };
  return {
    days: [today],
    today,
    streak: 0,
    bestStreak: 0,
    windowShortcut: 0,
    windowMouse: 0,
    windowShare: null,
    windowNeedsYou,
    byShortcut,
    topMissed: [],
    goalShare: 0.75,
    goalMinActions: 10,
  };
};

const split = (id: string, shortcut: number, mouse: number): ShortcutSplit => ({
  id,
  shortcut,
  mouse,
});

describe("recommend", () => {
  it("ranks the bindings the mouse keeps winning by clicks passed up", () => {
    const recs = recommend(score([split("ab-toggle-files", 0, 10), split("ab-new-task", 0, 21)]));
    expect(recs.map((r) => r.shortcut)).toEqual(["ab-new-task", "ab-toggle-files"]);
    expect(recs[0].why).toBe("Clicked 21× in 14 days, pressed 0×.");
    expect(recs[1].tip).toMatch(/folder focused/);
  });

  it("skips a stray click and a binding that is already a habit", () => {
    const recs = recommend(score([split("ab-new-session", 0, 2), split("ab-close-pane", 12, 3)]));
    expect(recs).toEqual([]);
  });

  it("names the jump chord when alerts go unanswered by key", () => {
    const recs = recommend(score([split("ab-jump-next", 5, 0)], 48));
    expect(recs[0]).toMatchObject({ shortcut: "ab-jump-next", missed: 43 });
    expect(recs[0].why).toBe("48 alerts fired in 14 days; you jumped to one by key 5×.");
  });

  it("counts every jump chord, digits included, against the alerts", () => {
    const recs = recommend(
      score([split("ab-jump-idle", 4, 0), split("ab-jump-session-2", 4, 0)], 10),
    );
    expect(recs).toEqual([]);
  });

  it("keeps the list short", () => {
    const recs = recommend(
      score(
        ["ab-new-task", "ab-toggle-files", "ab-new-session", "ab-close-pane"].map((id) =>
          split(id, 0, 5),
        ),
        20,
      ),
    );
    expect(recs).toHaveLength(MAX_RECOMMENDATIONS);
  });
});
