// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { QueueItem } from "@/lib/schemas/queue";
import { railNavigation } from "./rail-navigation";
import { folder, session, mockFn } from "./test-fixtures";

type Args = Parameters<typeof railNavigation>[0];

const row = (folderDir: string, over: Partial<QueueItem> = {}) =>
  ({ folderDir, lane: "doing", ...over }) as unknown as QueueItem;

function args(over: Partial<Args> = {}): Args {
  return {
    tree: false,
    now: 0,
    selected: null,
    activeFolderDir: null,
    activeFolder: undefined,
    activeWin: undefined,
    windowsForFolder: [],
    sessionById: new Map(),
    folderOf: new Map(),
    cwds: { current: {} },
    railRef: { current: {} as never },
    shownRepos: [],
    railQueue: {} as never,
    railTree: [],
    cursorKey: null,
    cursorNode: null,
    collapsed: {},
    rows: [],
    ringId: null,
    hotkeyTargets: [],
    focusLevel: "rail",
    focusedPaneId: null,
    jumpNonce: { current: 0 },
    applyCollapse: mockFn(),
    selectSession: mockFn(),
    selectFolder: mockFn(),
    focusWindow: mockFn(),
    setJumpRecall: mockFn(),
    setRailCursor: mockFn(),
    setFocusLevel: mockFn(),
    setFocusedPaneId: mockFn(),
    setFocusTerminalRequest: mockFn(),
    ...over,
  };
}

describe("jumpToHotkey", () => {
  it("declines a digit that addresses nothing, so the platform keeps the chord", () => {
    expect(railNavigation(args({ tree: true })).jumpToHotkey(3)).toBe(false);
    expect(railNavigation(args({ tree: false })).jumpToHotkey(1)).toBe(false);
  });

  it("selects the nth session on the tree", () => {
    const a = args({
      tree: true,
      hotkeyTargets: [
        { sessionId: "s1", folderDir: "/a" },
        { sessionId: "s2", folderDir: "/b" },
      ],
    });
    expect(railNavigation(a).jumpToHotkey(2)).toBe(true);
    expect(a.selectSession).toHaveBeenCalledWith("/b", "s2");
  });

  it("opens the nth queue row's session, else its checkout", () => {
    const a = args({
      rows: [row("/a", { sessionId: "s1" } as never), row("/b")],
    });
    const nav = railNavigation(a);
    nav.jumpToHotkey(1);
    expect(a.selectSession).toHaveBeenCalledWith("/a", "s1");
    nav.jumpToHotkey(2);
    expect(a.selectFolder).toHaveBeenCalledWith("/b");
  });
});

describe("moveQueueCursor", () => {
  it("steps from the ringed row, clamps at the end and declines on an empty queue", () => {
    const rows = [row("/a"), row("/b")];
    const a = args({ rows, ringId: "/a" });
    const nav = railNavigation(a);
    expect(nav.moveQueueCursor(1)).toBe(true);
    expect(a.selectFolder).toHaveBeenCalledWith("/b");
    const last = args({ rows, ringId: "/b" });
    expect(railNavigation(last).moveQueueCursor(1)).toBe(true);
    expect(last.selectFolder).toHaveBeenCalledWith("/b");
    expect(railNavigation(args()).moveQueueCursor(1)).toBe(false);
  });
});

describe("focusByArrow", () => {
  it("walks the queue with up and down, and steps into the panes with right", () => {
    const rows = [row("/a"), row("/b")];
    const a = args({
      rows,
      ringId: "/b",
      activeWin: { id: "w1", name: "w", folderDir: "/a", panes: ["s1"] },
      sessionById: new Map([["s1", session({ id: "s1" })]]),
      folderOf: new Map([["s1", folder({ dir: "/a" })]]),
    });
    const nav = railNavigation(a);
    expect(nav.focusByArrow("up")).toBe(true);
    expect(a.selectFolder).toHaveBeenCalledWith("/a");
    expect(nav.focusByArrow("left")).toBe(false);
    expect(nav.focusByArrow("right")).toBe(true);
    expect(a.selectSession).toHaveBeenCalledWith("/a", "s1");
    expect(a.setFocusLevel).toHaveBeenLastCalledWith("pane");
  });

  it("moves to the window strip when the folder holds several windows", () => {
    const a = args({
      windowsForFolder: [
        { id: "w1", name: "a", folderDir: "/a", panes: ["s1"] },
        { id: "w2", name: "b", folderDir: "/a", panes: ["s2"] },
      ],
    });
    expect(railNavigation(a).focusByArrow("right")).toBe(true);
    expect(a.setFocusLevel).toHaveBeenCalledWith("window");
    expect(a.setFocusedPaneId).toHaveBeenCalledWith(null);
  });

  it("declines right with nothing to the right of the rail", () => {
    expect(railNavigation(args()).focusByArrow("right")).toBe(false);
  });
});

describe("focusActiveTerminal", () => {
  it("declines without a checkout on screen", () => {
    expect(railNavigation(args()).focusActiveTerminal()).toBe(false);
  });

  it("selects the checkout's first session and asks for terminal focus", () => {
    const a = args({
      activeFolderDir: "/a",
      activeFolder: folder({ dir: "/a", sessions: [session({ id: "s9" })] }),
    });
    expect(railNavigation(a).focusActiveTerminal()).toBe(true);
    expect(a.selectSession).toHaveBeenCalledWith("/a", "s9");
    const bump = vi.mocked(a.setFocusTerminalRequest).mock.calls[0][0] as (
      r: { id: string; nonce: number } | null,
    ) => { id: string; nonce: number };
    expect(bump(null)).toEqual({ id: "s9", nonce: 1 });
    expect(bump({ id: "s9", nonce: 4 })).toEqual({ id: "s9", nonce: 5 });
  });
});

describe("collapseWholeRail", () => {
  it("declines when nothing would change", () => {
    const a = args({ collapsed: {} });
    expect(railNavigation(a).collapseWholeRail(false)).toBe(false);
    expect(a.applyCollapse).not.toHaveBeenCalled();
  });
});
