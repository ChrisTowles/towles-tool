import { describe, expect, it } from "vitest";
import { isListening, noteChip, type AgentNote, type InboxState } from "@/lib/inbox";

const note = (over: Partial<AgentNote>): AgentNote => ({
  id: 1,
  session: "s1",
  body: "x",
  source: "note",
  images: [],
  createdAt: 0,
  ...over,
});

const state = (notes: AgentNote[], listening: string[] = []): InboxState => ({ listening, notes });

describe("noteChip", () => {
  it("shows a pending note over one already delivered", () => {
    const s = state([note({ id: 1, deliveredAt: 5, deliveredHow: "prompt" }), note({ id: 2 })]);
    expect(noteChip(s, "s1")).toEqual({ kind: "pending" });
  });

  it("names how the last note was delivered", () => {
    const s = state([note({ deliveredAt: 5, deliveredHow: "midTurn" })]);
    expect(noteChip(s, "s1")).toEqual({ kind: "delivered", how: "midTurn" });
  });

  it("is nothing for another session's notes", () => {
    expect(noteChip(state([note({ session: "s2" })]), "s1")).toBeNull();
  });
});

describe("isListening", () => {
  it("is true only for a session whose mod polled", () => {
    expect(isListening(state([], ["s1"]), "s1")).toBe(true);
    expect(isListening(state([], ["s1"]), "s2")).toBe(false);
  });
});
