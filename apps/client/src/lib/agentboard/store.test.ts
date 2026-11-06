import { describe, expect, it } from "vitest";
import {
  OVERLAY_BACKSTOP_MS,
  OVERLAY_STARTED,
  OVERLAY_STOPPED,
  overlayConfirmed,
  settleOverlays,
} from "./overlays";
import { EMPTY_STATE, INITIAL_AGENTBOARD, updateAgentboard, type AgentboardMsg } from "./store";
import type { SessionData, StatePayload } from "./types";

const session = (id: string, working: boolean): SessionData => ({
  id,
  name: id,
  createdAt: 0,
  live: true,
  unseen: false,
  working,
  agents: [],
});

function payload(ts: number, sessions: SessionData[], computedAtMs = 0): StatePayload {
  const folder = { dir: "/a", needs: 0, computedAtMs, sessions };
  const repo = { key: "r", needs: 0, folders: [folder] };
  return { ...EMPTY_STATE, repos: [repo], ts } as unknown as StatePayload;
}

const sessionOf = (s: StatePayload, id: string) =>
  s.repos[0]!.folders[0]!.sessions.find((x) => x.id === id)!;

describe("overlayConfirmed", () => {
  it("needs a snapshot stamped after the overlay that agrees on `working`", () => {
    const o = { ...OVERLAY_STARTED, at: 100 };
    expect(overlayConfirmed(o, session("a", true), 100)).toBe(true);
    expect(overlayConfirmed(o, session("a", true), 99)).toBe(false);
    expect(overlayConfirmed(o, session("a", false), 200)).toBe(false);
    const stop = { ...OVERLAY_STOPPED, at: 100 };
    expect(overlayConfirmed(stop, session("a", false), 150)).toBe(true);
    expect(overlayConfirmed(stop, session("a", true), 150)).toBe(false);
  });
});

describe("settleOverlays", () => {
  const base = payload(200, [session("a", true), session("b", false)]);

  it("drops confirmed overlays and keeps the rest", () => {
    const overlays = {
      a: { ...OVERLAY_STARTED, at: 150 },
      b: { ...OVERLAY_STARTED, at: 150 },
    };
    expect(Object.keys(settleOverlays(overlays, base, 200, 1_000))).toEqual(["b"]);
  });

  it("keeps an overlay while only a stale snapshot disagrees, and returns the same object when nothing goes", () => {
    const overlays = { b: { ...OVERLAY_STARTED, at: 150 } };
    expect(settleOverlays(overlays, base, 200, 1_000)).toBe(overlays);
    expect(settleOverlays(overlays, payload(100, [session("b", false)]), 100, 1_000)).toBe(
      overlays,
    );
  });

  it("drops an unconfirmed overlay at the backstop", () => {
    const overlays = { b: { ...OVERLAY_STARTED, at: 1_000 } };
    expect(settleOverlays(overlays, base, 200, 1_000 + OVERLAY_BACKSTOP_MS - 1)).toBe(overlays);
    expect(settleOverlays(overlays, base, 200, 1_000 + OVERLAY_BACKSTOP_MS)).toEqual({});
  });

  it("drops an overlay whose session a newer snapshot no longer has", () => {
    const overlays = { gone: { ...OVERLAY_STARTED, at: 150 } };
    expect(settleOverlays(overlays, base, 200, 1_000)).toEqual({});
    expect(settleOverlays(overlays, payload(100, []), 100, 1_000)).toBe(overlays);
  });
});

type Msg = AgentboardMsg;
const run = (...msgs: Msg[]) => msgs.reduce(updateAgentboard, INITIAL_AGENTBOARD);
const accept = (p: StatePayload, now: number): Msg => ({ kind: "Accept", payload: p, now });

describe("updateAgentboard", () => {
  it("shares unchanged subtrees across payloads", () => {
    const m1 = run(accept(payload(1, [session("a", false), session("b", false)], 5), 0));
    const m2 = updateAgentboard(
      m1,
      accept(payload(2, [session("a", true), session("b", false)], 5), 0),
    );
    expect(m2.view).not.toBe(m1.view);
    expect(sessionOf(m2.view, "b")).toBe(sessionOf(m1.view, "b"));
    expect(sessionOf(m2.view, "a")).not.toBe(sessionOf(m1.view, "a"));
    expect(m2.view.ts).toBe(2);
  });

  it("treats a payload differing only in `ts` as no event", () => {
    const m1 = run(accept(payload(1, [session("a", false)]), 0));
    const m2 = updateAgentboard(m1, accept(payload(2, [session("a", false)]), 0));
    expect(m2.view).toBe(m1.view);
  });

  it("ignores a payload older than one already seen", () => {
    const m = run(
      accept(payload(5, [session("a", true)]), 0),
      accept(payload(3, [session("a", false)]), 0),
    );
    expect(sessionOf(m.view, "a").working).toBe(true);
  });

  it("holds an overlay across a snapshot that disagrees and ends it on one that agrees", () => {
    let m = run(accept(payload(100, [session("a", false)]), 100), {
      kind: "SetOverlay",
      id: "a",
      overlay: OVERLAY_STARTED,
      now: 150,
    });
    expect(sessionOf(m.view, "a").working).toBe(true);
    m = updateAgentboard(m, accept(payload(200, [session("a", false), session("b", false)]), 200));
    expect(sessionOf(m.view, "a").working).toBe(true);
    m = updateAgentboard(m, accept(payload(300, [session("a", true), session("b", false)]), 300));
    expect(sessionOf(m.view, "a").working).toBe(true);
    m = updateAgentboard(m, accept(payload(400, [session("a", false), session("b", false)]), 400));
    expect(sessionOf(m.view, "a").working).toBe(false);
  });

  it("settles a never-confirmed overlay at the backstop", () => {
    let m = run(accept(payload(100, [session("a", false)]), 100), {
      kind: "SetOverlay",
      id: "a",
      overlay: OVERLAY_STARTED,
      now: 150,
    });
    m = updateAgentboard(m, { kind: "Settle", now: 150 + OVERLAY_BACKSTOP_MS - 1 });
    expect(sessionOf(m.view, "a").working).toBe(true);
    m = updateAgentboard(m, { kind: "Settle", now: 150 + OVERLAY_BACKSTOP_MS });
    expect(sessionOf(m.view, "a").working).toBe(false);
  });
});
