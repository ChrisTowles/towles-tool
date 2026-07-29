import { describe, expect, it } from "vitest";
import {
  back,
  canGoBack,
  canGoForward,
  currentPath,
  forward,
  NO_HISTORY,
  openPath,
} from "./editor-history";

function trail(...paths: string[]) {
  return paths.reduce(openPath, NO_HISTORY);
}

describe("editor history", () => {
  it("starts empty and can go nowhere", () => {
    expect(currentPath(NO_HISTORY)).toBeNull();
    expect(canGoBack(NO_HISTORY)).toBe(false);
    expect(canGoForward(NO_HISTORY)).toBe(false);
  });

  it("walks back and forward over what was opened", () => {
    const h = trail("a.ts", "b.ts", "c.ts");
    expect(currentPath(h)).toBe("c.ts");
    const one = back(h);
    expect(currentPath(one)).toBe("b.ts");
    expect(currentPath(back(one))).toBe("a.ts");
    expect(currentPath(forward(one))).toBe("c.ts");
  });

  it("refuses to walk past either end, returning the same history", () => {
    const h = trail("a.ts");
    expect(back(h)).toBe(h);
    expect(forward(h)).toBe(h);
  });

  it("re-opening the current path changes nothing — no editor churn", () => {
    const h = trail("a.ts", "b.ts");
    expect(openPath(h, "b.ts")).toBe(h);
  });

  it("opening after going back abandons the forward branch", () => {
    const h = back(trail("a.ts", "b.ts", "c.ts"));
    const branched = openPath(h, "d.ts");
    expect(currentPath(branched)).toBe("d.ts");
    expect(canGoForward(branched)).toBe(false);
    expect(currentPath(back(branched))).toBe("b.ts");
  });

  it("caps the trail, dropping the oldest entries", () => {
    const many = Array.from({ length: 60 }, (_, i) => `f${i}.ts`);
    const h = trail(...many);
    expect(h.stack.length).toBe(50);
    expect(h.stack[0]).toBe("f10.ts");
    expect(currentPath(h)).toBe("f59.ts");
  });
});
