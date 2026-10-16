import { describe, expect, it } from "vitest";
import type { RailNode } from "@/lib/rail-nodes";
import { selectionActions, withoutKey, type RailSnapshot } from "./selection-actions";
import { mockFn } from "./test-fixtures";

const node = (over: Partial<RailNode>): RailNode => ({
  key: "k",
  kind: "folder",
  repoKey: "r",
  dir: "/r",
  sessionId: null,
  collapseKey: null,
  depth: 1,
  ...over,
});

function setup(railTree: RailNode[] = []) {
  const setters = {
    setOpen: mockFn(),
    setSelected: mockFn(),
    setJumpRecall: mockFn(),
    setRailCursor: mockFn(),
    setActiveFolderDir: mockFn(),
    setFocusedPaneId: mockFn(),
    setFocusLevel: mockFn(),
    setTermAttention: mockFn(),
  };
  const addPaneToActive = mockFn();
  const cwds = { current: {} as Record<string, string> };
  const railRef = {
    current: { railTree, folderNameByDir: new Map() } as unknown as RailSnapshot,
  };
  const actions = selectionActions({ ...setters, addPaneToActive, cwds, railRef });
  return { ...actions, setters, addPaneToActive, cwds };
}

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

describe("mountSession", () => {
  it("records the cwd, mounts the PTY once and tiles the pane", () => {
    const { mountSession, setters, addPaneToActive, cwds } = setup();
    mountSession("/r", "s1");
    expect(cwds.current).toEqual({ s1: "/r" });
    expect(addPaneToActive).toHaveBeenCalledWith("/r", "s1");
    const updater = setters.setOpen.mock.calls[0][0] as (prev: string[]) => string[];
    expect(updater([])).toEqual(["s1"]);
    const already = ["s1"];
    expect(updater(already)).toBe(already);
  });
});

describe("selectSession", () => {
  it("lands as one batch: selection, ring, rail level, folder and cleared attention", () => {
    const row = node({ key: "s", kind: "session", sessionId: "s1" });
    const { selectSession, setters } = setup([node({}), row]);
    selectSession("/r", "s1");
    expect(setters.setJumpRecall).toHaveBeenCalledWith(null);
    expect(setters.setRailCursor).toHaveBeenCalledWith(row);
    expect(setters.setSelected).toHaveBeenCalledWith({ folderDir: "/r", sessionId: "s1" });
    expect(setters.setFocusedPaneId).toHaveBeenCalledWith("s1");
    expect(setters.setFocusLevel).toHaveBeenCalledWith("rail");
    expect(setters.setActiveFolderDir).toHaveBeenCalledWith("/r");
    const clear = setters.setTermAttention.mock.calls[0][0] as (
      m: Record<string, true>,
    ) => Record<string, true>;
    expect(clear({ s1: true, s2: true })).toEqual({ s2: true });
  });
});

describe("selectFolder", () => {
  it("hands the cursor to the checkout's row and drops a selection in another folder", () => {
    const row = node({ key: "f", dir: "/r" });
    const { selectFolder, setters } = setup([row]);
    selectFolder("/r");
    expect(setters.setRailCursor).toHaveBeenCalledWith(row);
    expect(setters.setActiveFolderDir).toHaveBeenCalledWith("/r");
    const drop = setters.setSelected.mock.calls[0][0] as (
      cur: { folderDir: string; sessionId: string } | null,
    ) => unknown;
    expect(drop({ folderDir: "/other", sessionId: "x" })).toBeNull();
    const keep = { folderDir: "/r", sessionId: "x" };
    expect(drop(keep)).toBe(keep);
  });

  it("leaves the cursor alone when no row stands for the checkout", () => {
    const { selectFolder, setters } = setup([]);
    selectFolder("/r");
    expect(setters.setRailCursor).not.toHaveBeenCalled();
  });
});
