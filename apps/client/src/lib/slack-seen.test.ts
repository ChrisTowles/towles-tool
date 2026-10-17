import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { firstUnseenIndex, newestTs } from "./slack-seen";

const theirs = (tsRaw: string) => ({ tsRaw, fromMe: false });
const mine = (tsRaw: string) => ({ tsRaw, fromMe: true });

describe("firstUnseenIndex", () => {
  const list = [theirs("100.1"), mine("101.1"), theirs("102.1"), theirs("103.1")];

  it("is the first message past the last-seen one", () => {
    expect(firstUnseenIndex(list, "101.1")).toBe(2);
    expect(firstUnseenIndex(list, "99.0")).toBe(0);
  });

  it("is none on a first visit", () => {
    expect(firstUnseenIndex(list, null)).toBeNull();
  });

  it("is none when everything was seen", () => {
    expect(firstUnseenIndex(list, "103.1")).toBeNull();
    expect(firstUnseenIndex(list, "200.0")).toBeNull();
    expect(firstUnseenIndex([], "100.0")).toBeNull();
  });

  it("never counts your own messages", () => {
    expect(firstUnseenIndex([theirs("100.1"), mine("105.1")], "100.1")).toBeNull();
    expect(firstUnseenIndex([theirs("100.1"), mine("101.1"), theirs("102.1")], "100.1")).toBe(2);
  });

  it("orders numerically across a seconds-width change", () => {
    const wide = [theirs("999999999.1"), theirs("1000000000.1")];
    expect(firstUnseenIndex(wide, "999999999.1")).toBe(1);
  });

  it("orders by micros within a second, short fractions padded", () => {
    const pair = [theirs("1720000100.000100"), theirs("1720000100.000200")];
    expect(firstUnseenIndex(pair, "1720000100.000100")).toBe(1);
    expect(firstUnseenIndex([theirs("1720000100.5")], "1720000100.500000")).toBeNull();
    expect(firstUnseenIndex([theirs("1720000100.5")], "1720000100.000005")).toBe(0);
  });

  it("treats an unparseable last-seen as older than everything", () => {
    expect(firstUnseenIndex(list, "junk")).toBe(0);
  });
});

describe("newestTs", () => {
  it("is the largest id whoever sent it", () => {
    expect(newestTs([theirs("100.1"), mine("1000.1"), theirs("999.9")])).toBe("1000.1");
  });

  it("is none for an empty list", () => {
    expect(newestTs([])).toBeNull();
  });
});

describe("the shared last-seen value", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.resetModules();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("starts empty and persists what is marked", async () => {
    const seen = await import("./slack-seen");
    expect(seen.getLastSeen()).toBeNull();
    seen.markSeen("100.1");
    expect(seen.getLastSeen()).toBe("100.1");
    expect(store.get("tt-slack-seen")).toBe("100.1");
  });

  it("only moves forward, so a stale list cannot resurrect a divider", async () => {
    const seen = await import("./slack-seen");
    seen.markSeen("200.1");
    seen.markSeen("100.1");
    seen.markSeen(null);
    expect(seen.getLastSeen()).toBe("200.1");
    expect(store.get("tt-slack-seen")).toBe("200.1");
  });

  it("restores a stored value and drops a malformed one", async () => {
    store.set("tt-slack-seen", "1720000100.000100");
    expect((await import("./slack-seen")).getLastSeen()).toBe("1720000100.000100");
    vi.resetModules();
    store.set("tt-slack-seen", "yesterday");
    expect((await import("./slack-seen")).getLastSeen()).toBeNull();
  });
});
