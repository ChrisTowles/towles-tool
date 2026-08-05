import { describe, expect, it } from "vitest";
import {
  mruNext,
  nextAfterClose,
  NO_TABS,
  reopenTarget,
  tabLabels,
  tabsOnClose,
  tabsOnOpen,
  type PaneTabs,
} from "./editor-tabs";

function openAll(paths: string[]): PaneTabs {
  return paths.reduce(tabsOnOpen, NO_TABS);
}

describe("tabsOnOpen", () => {
  it("appends new paths in visual order and fronts the MRU", () => {
    const t = openAll(["a.ts", "b.ts", "c.ts"]);
    expect(t.order).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(t.mru).toEqual(["c.ts", "b.ts", "a.ts"]);
  });

  it("re-opening an existing tab moves MRU but never visual order", () => {
    const t = tabsOnOpen(openAll(["a.ts", "b.ts", "c.ts"]), "a.ts");
    expect(t.order).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(t.mru).toEqual(["a.ts", "c.ts", "b.ts"]);
  });

  it("is identity for the already-active path — safe on every render", () => {
    const t = openAll(["a.ts", "b.ts"]);
    expect(tabsOnOpen(t, "b.ts")).toBe(t);
  });

  it("removes a reopened path from the closed stack", () => {
    const t = tabsOnClose(openAll(["a.ts", "b.ts"]), "a.ts");
    expect(tabsOnOpen(t, "a.ts").closed).toEqual([]);
  });
});

describe("tabsOnClose", () => {
  it("removes from order and mru and pushes onto closed", () => {
    const t = tabsOnClose(openAll(["a.ts", "b.ts"]), "a.ts");
    expect(t.order).toEqual(["b.ts"]);
    expect(t.mru).toEqual(["b.ts"]);
    expect(t.closed).toEqual(["a.ts"]);
  });

  it("ignores a path that is not a tab", () => {
    const t = openAll(["a.ts"]);
    expect(tabsOnClose(t, "zz.ts")).toBe(t);
  });

  it("caps the closed stack", () => {
    let t = openAll(Array.from({ length: 25 }, (_, i) => `f${i}.ts`));
    for (let i = 0; i < 25; i++) t = tabsOnClose(t, `f${i}.ts`);
    expect(t.closed).toHaveLength(20);
    expect(t.closed[0]).toBe("f24.ts");
  });
});

describe("nextAfterClose", () => {
  it("prefers the most recently used other tab", () => {
    const t = tabsOnOpen(openAll(["a.ts", "b.ts", "c.ts"]), "a.ts");
    expect(nextAfterClose(t, "a.ts")).toBe("c.ts");
  });

  it("falls back to the visual neighbor, then null for the last tab", () => {
    const bare: PaneTabs = { order: ["a.ts", "b.ts"], mru: [], closed: [] };
    expect(nextAfterClose(bare, "a.ts")).toBe("b.ts");
    expect(nextAfterClose(bare, "b.ts")).toBe("a.ts");
    expect(nextAfterClose(openAll(["only.ts"]), "only.ts")).toBeNull();
  });
});

describe("mruNext", () => {
  it("cycles through recency order, wrapping", () => {
    const t = openAll(["a.ts", "b.ts", "c.ts"]); // mru: c, b, a
    expect(mruNext(t, "c.ts")).toBe("b.ts");
    expect(mruNext(t, "a.ts")).toBe("c.ts");
  });

  it("has nowhere to go with fewer than two tabs", () => {
    expect(mruNext(openAll(["a.ts"]), "a.ts")).toBeNull();
    expect(mruNext(NO_TABS, null)).toBeNull();
  });
});

describe("reopenTarget", () => {
  it("is the most recently closed path", () => {
    let t = openAll(["a.ts", "b.ts"]);
    t = tabsOnClose(t, "a.ts");
    t = tabsOnClose(t, "b.ts");
    expect(reopenTarget(t)).toBe("b.ts");
    expect(reopenTarget(NO_TABS)).toBeNull();
  });
});

describe("tabLabels", () => {
  it("uses basenames until two collide, then appends the parent dir", () => {
    const labels = tabLabels(["src/lib/mod.rs", "src/app/mod.rs", "README.md"]);
    expect(labels.get("src/lib/mod.rs")).toBe("mod.rs — lib");
    expect(labels.get("src/app/mod.rs")).toBe("mod.rs — app");
    expect(labels.get("README.md")).toBe("README.md");
  });

  it("keeps a bare root-level name even when it collides", () => {
    const labels = tabLabels(["mod.rs", "src/mod.rs"]);
    expect(labels.get("mod.rs")).toBe("mod.rs");
    expect(labels.get("src/mod.rs")).toBe("mod.rs — src");
  });
});
