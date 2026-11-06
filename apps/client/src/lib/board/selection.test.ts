import { describe, expect, it } from "vitest";
import { INITIAL_BOARD_UI, normalize } from "./model";
import { mounted, toFolder, toSession, withoutKey } from "./selection";

describe("withoutKey", () => {
  it("returns the same object when the key is absent", () => {
    const m = { a: true as const };
    expect(withoutKey(m, "b")).toBe(m);
  });

  it("returns a copy without the key", () => {
    const m = { a: true as const, b: true as const };
    expect(withoutKey(m, "a")).toEqual({ b: true });
    expect(m).toEqual({ a: true, b: true });
  });
});

describe("mounted", () => {
  it("records the cwd and mounts the PTY once", () => {
    const once = mounted("/r", "s1")(INITIAL_BOARD_UI);
    expect(once.cwds).toEqual({ s1: "/r" });
    expect(once.open).toEqual(["s1"]);
    const twice = mounted("/r", "s1")(once);
    expect(twice.open).toBe(once.open);
    expect(twice.cwds).toBe(once.cwds);
  });
});

describe("toSession", () => {
  it("lands as one write: selection, folder, pane focus, rail level, cleared attention", () => {
    const ui = toSession(
      "/r",
      "s1",
    )({
      ...INITIAL_BOARD_UI,
      termAttention: { s1: true, s2: true },
      jumpRecall: { sessionId: "x" } as never,
    });
    expect(normalize(ui)).toBe(ui);
    expect(ui.selected).toEqual({ folderDir: "/r", sessionId: "s1" });
    expect(ui.activeFolderDir).toBe("/r");
    expect(ui.focusedPaneId).toBe("s1");
    expect(ui.focusLevel).toBe("rail");
    expect(ui.jumpRecall).toBeNull();
    expect(ui.termAttention).toEqual({ s2: true });
    expect(ui.open).toEqual(["s1"]);
  });
});

describe("toFolder", () => {
  it("drops a selection left in another checkout", () => {
    const inA = toSession("/a", "s1")(INITIAL_BOARD_UI);
    const inB = normalize(toFolder("/b")(inA));
    expect(inB.activeFolderDir).toBe("/b");
    expect(inB.selected).toBeNull();
  });

  it("keeps the selection when the checkout is the same", () => {
    const inA = toSession("/a", "s1")(INITIAL_BOARD_UI);
    expect(normalize(toFolder("/a")(inA)).selected).toEqual({ folderDir: "/a", sessionId: "s1" });
  });
});
