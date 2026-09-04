import { describe, expect, it } from "vitest";
import { dmSignal } from "./slack";
import type { DmItem } from "./data";

function dm(over: Partial<DmItem> = {}): DmItem {
  return {
    channel: "D1",
    fromName: "Danielle",
    text: "hi",
    ts: 100,
    fromMe: false,
    fetchedAt: 200,
    dismissedTs: 0,
    ...over,
  };
}

describe("dmSignal", () => {
  it("holds steady when the row is unchanged", () => {
    expect(dmSignal([dm()])).toBe(dmSignal([dm()]));
  });

  // The collector restamps `fetchedAt` on every run, so this is what says
  // "re-pull" when a reply or reaction leaves the top-level message identical.
  it("moves when the collector reruns", () => {
    expect(dmSignal([dm({ fetchedAt: 300 })])).not.toBe(dmSignal([dm()]));
  });

  it("moves on a new message and on a dismissal", () => {
    expect(dmSignal([dm({ ts: 101 })])).not.toBe(dmSignal([dm()]));
    expect(dmSignal([dm({ dismissedTs: 100 })])).not.toBe(dmSignal([dm()]));
  });

  // Everything else in a snapshot churns on unrelated work; refetching on it
  // cost a 50-message Slack call per store write.
  it("ignores the rest of the row", () => {
    expect(dmSignal([dm({ text: "different", fromName: "Someone" })])).toBe(dmSignal([dm()]));
  });

  it("separates channels rather than colliding them", () => {
    expect(dmSignal([dm(), dm({ channel: "D2" })])).not.toBe(dmSignal([dm(), dm()]));
  });
});
