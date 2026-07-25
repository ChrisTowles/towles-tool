import { describe, expect, it } from "vitest";
import {
  FLUENT_USES,
  MAX_NUDGES_PER_SESSION,
  NUDGE_COOLDOWN_MS,
  emptyCoachState,
  keyboardUsesToday,
  noteNudge,
  shouldNudge,
} from "./shortcut-coach";

const ctx = { enabled: true, keyboardUsesToday: 0 };
const NOW = 1_700_000_000_000;

describe("shouldNudge", () => {
  it("coaches the first click on a binding", () => {
    expect(shouldNudge(emptyCoachState(), "sidebar", NOW, ctx)).toBe(true);
  });

  it("stays quiet for the rest of the cooldown, then speaks again", () => {
    const state = noteNudge(emptyCoachState(), "sidebar", NOW);
    expect(shouldNudge(state, "sidebar", NOW + NUDGE_COOLDOWN_MS - 1, ctx)).toBe(false);
    expect(shouldNudge(state, "sidebar", NOW + NUDGE_COOLDOWN_MS, ctx)).toBe(true);
  });

  it("cools down per binding, not globally", () => {
    const state = noteNudge(emptyCoachState(), "sidebar", NOW);
    expect(shouldNudge(state, "settings", NOW, ctx)).toBe(true);
  });

  it("gives up after the session's budget, whatever the binding", () => {
    let state = emptyCoachState();
    for (let i = 0; i < MAX_NUDGES_PER_SESSION; i++) state = noteNudge(state, `id-${i}`, NOW);
    expect(shouldNudge(state, "never-nudged", NOW, ctx)).toBe(false);
  });

  /** Clicking a shortcut you demonstrably know is a choice, not a lapse. */
  it("says nothing about a binding already driven from the keyboard today", () => {
    const fluent = { ...ctx, keyboardUsesToday: FLUENT_USES };
    expect(shouldNudge(emptyCoachState(), "sidebar", NOW, fluent)).toBe(false);
    expect(shouldNudge(emptyCoachState(), "sidebar", NOW, { ...ctx, keyboardUsesToday: 2 })).toBe(
      true,
    );
  });

  it("is silent when the setting is off", () => {
    expect(shouldNudge(emptyCoachState(), "sidebar", NOW, { ...ctx, enabled: false })).toBe(false);
  });
});

describe("keyboardUsesToday", () => {
  const score = {
    today: {
      byShortcut: [
        { id: "sidebar", shortcut: 4 },
        { id: "settings", shortcut: 0 },
      ],
    },
  };

  it("reads the day's keyboard count for a binding", () => {
    expect(keyboardUsesToday(score, "sidebar")).toBe(4);
    expect(keyboardUsesToday(score, "settings")).toBe(0);
  });

  /** Before the first poll lands there's no evidence of fluency, so the coach
   * should be free to speak rather than assume the user is expert. */
  it("is zero with no score yet and for an unseen binding", () => {
    expect(keyboardUsesToday(null, "sidebar")).toBe(0);
    expect(keyboardUsesToday(score, "zen")).toBe(0);
  });
});
