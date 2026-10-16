import { describe, expect, it } from "vitest";
import {
  FLUENT_USES,
  NUDGE_AFTER_CLICKS,
  STEP_GAP_MS,
  emptyCoachState,
  keyboardUsesToday,
  noteClick,
  noteStep,
  parseCoachState,
} from "./shortcut-coach";

const ctx = { enabled: true, keyboardUsesToday: 0 };

function clicks(n: number, id = "ab-new-session", c = ctx) {
  let state = emptyCoachState();
  const nudges: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const r = noteClick(state, id, c);
    state = r.state;
    nudges.push(r.nudge);
  }
  return { state, nudges };
}

describe("noteClick", () => {
  it("tips once, on the third click, and never again", () => {
    const { nudges } = clicks(10);
    expect(nudges.indexOf(true)).toBe(NUDGE_AFTER_CLICKS - 1);
    expect(nudges.filter(Boolean)).toHaveLength(1);
  });

  it("counts per binding", () => {
    const { state } = clicks(NUDGE_AFTER_CLICKS);
    expect(noteClick(state, "ab-close-pane", ctx).nudge).toBe(false);
  });

  it("is silent when the setting is off, and still tips later once it's on", () => {
    const off = clicks(NUDGE_AFTER_CLICKS, "zen", { ...ctx, enabled: false });
    expect(off.nudges.some(Boolean)).toBe(false);
    expect(noteClick(off.state, "zen", ctx).nudge).toBe(true);
  });

  /** Clicking a shortcut you demonstrably know is a choice, not a lapse. */
  it("says nothing about a binding already driven from the keyboard today", () => {
    const fluent = clicks(5, "zen", { ...ctx, keyboardUsesToday: FLUENT_USES });
    expect(fluent.nudges.some(Boolean)).toBe(false);
  });
});

describe("noteStep", () => {
  it("counts a quick run and restarts after a pause", () => {
    let run = { count: 0, at: 0 };
    run = noteStep(run, 10_000);
    run = noteStep(run, 10_500);
    expect(run.count).toBe(2);
    run = noteStep(run, 10_500 + STEP_GAP_MS + 1);
    expect(run.count).toBe(1);
  });
});

describe("parseCoachState", () => {
  it("round-trips and degrades malformed input to empty", () => {
    const { state } = clicks(NUDGE_AFTER_CLICKS);
    expect(parseCoachState(JSON.stringify(state))).toEqual(state);
    expect(parseCoachState("{nope")).toEqual(emptyCoachState());
    expect(parseCoachState(null)).toEqual(emptyCoachState());
    expect(parseCoachState(JSON.stringify({ nudged: [1, "zen"] })).nudged).toEqual(["zen"]);
  });
});

describe("keyboardUsesToday", () => {
  const score = { today: { byShortcut: [{ id: "sidebar", shortcut: 4 }] } };

  it("reads the day's keyboard count for a binding, zero when unseen", () => {
    expect(keyboardUsesToday(score, "sidebar")).toBe(4);
    expect(keyboardUsesToday(score, "zen")).toBe(0);
    expect(keyboardUsesToday(null, "sidebar")).toBe(0);
  });
});
