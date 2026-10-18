import { describe, expect, it } from "vitest";
import {
  OVERLAY_BACKSTOP_MS,
  OVERLAY_STARTED,
  OVERLAY_STOPPED,
  overlayConfirmed,
  settleOverlays,
} from "./overlays";
import { createAgentboardStore, EMPTY_STATE } from "./store";
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

describe("createAgentboardStore", () => {
  it("shares unchanged subtrees across payloads", () => {
    const store = createAgentboardStore();
    store.accept(payload(1, [session("a", false), session("b", false)], 5), 0);
    const first = store.state.get();
    store.accept(payload(2, [session("a", true), session("b", false)], 5), 0);
    const second = store.state.get();
    expect(second).not.toBe(first);
    expect(sessionOf(second, "b")).toBe(sessionOf(first, "b"));
    expect(sessionOf(second, "a")).not.toBe(sessionOf(first, "a"));
    expect(second.ts).toBe(2);
  });

  it("treats a payload differing only in `ts` as no event", () => {
    const store = createAgentboardStore();
    store.accept(payload(1, [session("a", false)]), 0);
    const first = store.state.get();
    let woken = 0;
    store.state.subscribe(() => woken++);
    store.accept(payload(2, [session("a", false)]), 0);
    expect(store.state.get()).toBe(first);
    expect(woken).toBe(0);
  });

  it("ignores a payload older than one already seen", () => {
    const store = createAgentboardStore();
    store.accept(payload(5, [session("a", true)]), 0);
    store.accept(payload(3, [session("a", false)]), 0);
    expect(sessionOf(store.state.get(), "a").working).toBe(true);
  });

  it("holds an overlay across a snapshot that disagrees and ends it on one that agrees", () => {
    const store = createAgentboardStore();
    store.accept(payload(100, [session("a", false)]), 100);
    store.setOverlay("a", OVERLAY_STARTED, 150);
    expect(sessionOf(store.state.get(), "a").working).toBe(true);

    store.accept(payload(200, [session("a", false), session("b", false)]), 200);
    expect(sessionOf(store.state.get(), "a").working).toBe(true);

    store.accept(payload(300, [session("a", true), session("b", false)]), 300);
    expect(sessionOf(store.state.get(), "a").working).toBe(true);
    store.accept(payload(400, [session("a", false), session("b", false)]), 400);
    expect(sessionOf(store.state.get(), "a").working).toBe(false);
  });

  it("settles a never-confirmed overlay at the backstop", () => {
    const store = createAgentboardStore();
    store.accept(payload(100, [session("a", false)]), 100);
    store.setOverlay("a", OVERLAY_STARTED, 150);
    store.settle(150 + OVERLAY_BACKSTOP_MS - 1);
    expect(sessionOf(store.state.get(), "a").working).toBe(true);
    store.settle(150 + OVERLAY_BACKSTOP_MS);
    expect(sessionOf(store.state.get(), "a").working).toBe(false);
  });
});
