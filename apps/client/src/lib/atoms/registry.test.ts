import { Effect } from "effect";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { describe, expect, it } from "vitest";

describe("atom spine", () => {
  it("a derived atom follows its source and keeps identity when unchanged", () => {
    const r = AtomRegistry.make();
    const src = Atom.make({ a: [1], b: 2 }).pipe(Atom.keepAlive);
    const a = Atom.make((get) => get(src).a);
    const seen: number[][] = [];
    r.subscribe(a, (v) => seen.push(v), { immediate: true });
    const prev = r.get(src);
    r.set(src, { ...prev, b: 3 });
    expect(seen.length).toBe(1);
    r.set(src, { a: [2], b: 3 });
    expect(seen).toEqual([[1], [2]]);
  });

  it("an effect atom can write a state atom when mounted", () => {
    const r = AtomRegistry.make();
    const state = Atom.make(0).pipe(Atom.keepAlive);
    const feed = Atom.make((get) => Effect.sync(() => get.set(state, 7)));
    expect(r.get(state)).toBe(0);
    r.mount(feed);
    expect(r.get(state)).toBe(7);
  });
});
