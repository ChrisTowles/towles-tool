import { describe, expect, it, vi } from "vitest";
import { FocusTargetStore, type FocusTarget } from "./focus-target";

const prTarget: FocusTarget = { screen: "cockpit", kind: "pr", id: "octo/widgets#43" };
const todoTarget: FocusTarget = { screen: "board", kind: "todo", id: "7" };

describe("FocusTargetStore", () => {
  it("starts empty", () => {
    expect(new FocusTargetStore().get()).toBeNull();
  });

  it("set stashes a target that get returns", () => {
    const store = new FocusTargetStore();
    store.set(prTarget);
    expect(store.get()).toEqual(prTarget);
  });

  it("consume returns and clears the target when the screen matches", () => {
    const store = new FocusTargetStore();
    store.set(prTarget);
    expect(store.consume("cockpit")).toEqual(prTarget);
    // One-shot: a second consume finds nothing.
    expect(store.consume("cockpit")).toBeNull();
    expect(store.get()).toBeNull();
  });

  it("consume leaves a target for another screen untouched", () => {
    const store = new FocusTargetStore();
    store.set(todoTarget);
    expect(store.consume("cockpit")).toBeNull();
    expect(store.get()).toEqual(todoTarget);
    // The real destination still gets it.
    expect(store.consume("board")).toEqual(todoTarget);
  });

  it("clear drops a pending target", () => {
    const store = new FocusTargetStore();
    store.set(prTarget);
    store.clear();
    expect(store.get()).toBeNull();
  });

  it("notifies subscribers on set, consume, and clear — but not on a no-op", () => {
    const store = new FocusTargetStore();
    const fn = vi.fn<() => void>();
    const unsub = store.subscribe(fn);

    store.set(prTarget); // 1
    store.consume("cockpit"); // 2 (matches → clears)
    store.clear(); // no-op: already empty
    store.set(todoTarget); // 3
    store.consume("cockpit"); // no-op: screen mismatch
    expect(fn).toHaveBeenCalledTimes(3);

    unsub();
    store.set(prTarget);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
