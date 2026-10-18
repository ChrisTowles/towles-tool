import { describe, expect, it, vi } from "vitest";
import { createStore } from "./external-store";

describe("createStore", () => {
  it("notifies on a new value and not on the same reference", () => {
    const store = createStore({ n: 1 });
    const seen = vi.fn<() => void>();
    store.subscribe(seen);
    const held = store.get();
    store.set(held);
    expect(seen).not.toHaveBeenCalled();
    store.set({ n: 2 });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual({ n: 2 });
  });

  it("stops notifying after unsubscribe", () => {
    const store = createStore(0);
    const seen = vi.fn<() => void>();
    const off = store.subscribe(seen);
    off();
    store.set(1);
    expect(seen).not.toHaveBeenCalled();
  });
});
