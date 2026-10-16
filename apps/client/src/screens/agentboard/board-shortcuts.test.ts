// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { QueueItem } from "@/lib/schemas/queue";
import { boardShortcuts, type BoardShortcutContext } from "./board-shortcuts";
import { folder, mockFn } from "./test-fixtures";

function context(over: Partial<BoardShortcutContext> = {}): BoardShortcutContext {
  return {
    tree: true,
    activeFolderDir: "/code/proj",
    activeFolder: folder({}),
    activeWin: undefined,
    selected: null,
    sessionById: new Map(),
    ringItem: undefined,
    shownQueueItems: [],
    worktreeDelete: {
      blockedDelete: null,
      forceDeleteBlocked: mockFn(),
      confirmDeleteWt: null,
      confirmDeleteWorktree: mockFn(),
    },
    newSession: vi.fn<() => Promise<void>>(async () => {}),
    openRailNewTask: mockFn(),
    requestDeleteWorktree: mockFn(),
    closeFocusedPane: mockFn(),
    openFiles: mockFn(),
    toggleRail: mockFn(),
    setRailView: mockFn(),
    jumpToNeedsYou: mockFn(),
    jumpToNotBusy: mockFn(),
    jumpToHotkey: vi.fn<() => boolean>(() => true),
    focusByArrow: vi.fn<() => boolean>(() => true),
    collapseWholeRail: vi.fn<() => boolean>(() => true),
    moveQueueCursor: vi.fn<() => boolean>(() => true),
    setSnoozeId: mockFn(),
    queueActions: {
      landAll: vi.fn<() => boolean>(() => true),
      openCiLog: vi.fn<() => boolean>(() => true),
      restart: vi.fn<() => boolean>(() => true),
      fork: vi.fn<() => boolean>(() => true),
    },
    folderByDir: new Map(),
    focusActiveTerminal: vi.fn<() => boolean>(() => true),
    splitIntoWindow: mockFn(),
    ...over,
  };
}

describe("boardShortcuts", () => {
  it("binds one jump chord per digit, each addressing its own number", () => {
    const c = context();
    const map = boardShortcuts(c);
    for (let n = 1; n <= 9; n++) map[`ab-jump-session-${n}`]();
    expect(vi.mocked(c.jumpToHotkey).mock.calls.map(([n]) => n)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(map["ab-jump-session-10"]).toBeUndefined();
  });

  it("only offers each rail's own chords while it is up", () => {
    const tree = boardShortcuts(context({ tree: true }));
    expect(tree["ab-collapse-all"]).toBeDefined();
    expect(tree["queue-down"]).toBeUndefined();
    const queue = boardShortcuts(context({ tree: false }));
    expect(queue["queue-down"]).toBeDefined();
    expect(queue["ab-collapse-all"]).toBeUndefined();
  });

  it("flips the rail view from wherever it is", () => {
    const c = context({ tree: true });
    boardShortcuts(c)["ab-rail-view"]();
    expect(c.setRailView).toHaveBeenCalledWith("queue");
    const q = context({ tree: false });
    boardShortcuts(q)["ab-rail-view"]();
    expect(q.setRailView).toHaveBeenCalledWith("tree");
  });

  it("starts sessions and opens files only with a checkout on screen", () => {
    const none = context({ activeFolderDir: null });
    const noneMap = boardShortcuts(none);
    noneMap["ab-new-session"]();
    noneMap["ab-toggle-files"]();
    expect(none.newSession).not.toHaveBeenCalled();
    expect(none.openFiles).not.toHaveBeenCalled();
    const c = context();
    const map = boardShortcuts(c);
    map["ab-new-terminal-right"]();
    map["ab-toggle-files"]();
    expect(c.newSession).toHaveBeenCalledWith("/code/proj");
    expect(c.openFiles).toHaveBeenCalledWith("/code/proj");
  });

  it("declines the confirm chord when no delete flow is open", () => {
    const c = context();
    expect(boardShortcuts(c)["ab-confirm-close-worktree"]()).toBe(false);
    expect(c.worktreeDelete.confirmDeleteWorktree).not.toHaveBeenCalled();
  });

  it("confirms the first dialog, or forces the blocked one when the guards refused", () => {
    const confirming = context({
      worktreeDelete: {
        blockedDelete: null,
        forceDeleteBlocked: mockFn(),
        confirmDeleteWt: { label: "x", dirs: ["/x"], sessionIds: [] },
        confirmDeleteWorktree: mockFn(),
      },
    });
    boardShortcuts(confirming)["ab-confirm-close-worktree"]();
    expect(confirming.worktreeDelete.confirmDeleteWorktree).toHaveBeenCalledOnce();

    const blocked = context({
      worktreeDelete: {
        blockedDelete: {} as never,
        forceDeleteBlocked: mockFn(),
        confirmDeleteWt: null,
        confirmDeleteWorktree: mockFn(),
      },
    });
    boardShortcuts(blocked)["ab-confirm-close-worktree"]();
    expect(blocked.worktreeDelete.forceDeleteBlocked).toHaveBeenCalledOnce();
    expect(blocked.worktreeDelete.confirmDeleteWorktree).not.toHaveBeenCalled();
  });

  it("won't remove a checkout that isn't a task", () => {
    const c = context({ activeFolder: folder({ record: { origin: "checkout" } }) });
    boardShortcuts(c)["ab-remove-task"]();
    expect(c.requestDeleteWorktree).not.toHaveBeenCalled();
  });

  it("declines snooze when the ringed row has nothing to snooze", () => {
    const snoozed = { folderDir: "/a", reason: "waiting", snoozed: true } as unknown as QueueItem;
    const c = context({ tree: false, ringItem: snoozed });
    expect(boardShortcuts(c)["queue-snooze"]()).toBe(false);
    expect(c.setSnoozeId).not.toHaveBeenCalled();

    const live = { folderDir: "/a", reason: "waiting", snoozed: false } as unknown as QueueItem;
    const c2 = context({ tree: false, ringItem: live });
    boardShortcuts(c2)["queue-snooze"]();
    expect(c2.setSnoozeId).toHaveBeenCalledWith("/a");
  });

  it("declines the note chord when no agent is in view", () => {
    expect(boardShortcuts(context())["ab-note-agent"]()).toBe(false);
  });

  it("lists Shift+L's land before l's CI log, so the first match is the right one", () => {
    const keys = Object.keys(boardShortcuts(context({ tree: false })));
    expect(keys.indexOf("queue-land")).toBeLessThan(keys.indexOf("queue-ci-log"));
  });

  it("hands the queue's row verbs the ringed row, and declines without one", () => {
    const ringItem = { folderDir: "/w1" } as QueueItem;
    const c = context({ tree: false, ringItem });
    const map = boardShortcuts(c);
    map["queue-fork"]();
    map["queue-restart"]();
    expect(vi.mocked(c.queueActions.fork)).toHaveBeenCalledWith(ringItem);
    expect(vi.mocked(c.queueActions.restart)).toHaveBeenCalledWith(ringItem);
    expect(boardShortcuts(context({ tree: false }))["queue-ci-log"]()).toBe(false);
  });
});
