import { beforeEach, describe, expect, it, vi } from "vitest";
import { filesPaneId } from "@/lib/agentboard/pane-ids";
import { untrackRepo } from "@/lib/repo-actions";
import { sessionLifecycle } from "./session-lifecycle";
import { folder, repo, session, mockFn } from "./test-fixtures";

vi.mock("@/lib/repo-actions", () => ({ untrackRepo: vi.fn<() => Promise<void>>(async () => {}) }));
vi.mock("@/lib/toast", () => ({
  toast: Object.assign(vi.fn<(...args: unknown[]) => unknown>(), {
    error: vi.fn<(...args: unknown[]) => unknown>(),
  }),
}));

type Args = Parameters<typeof sessionLifecycle>[0];

function args(over: Partial<Args> = {}): Args {
  return {
    repos: [],
    wins: null,
    focusedPaneId: null,
    selected: null,
    activePanes: [],
    sessionById: new Map(),
    expectedKills: { current: new Set() },
    labelFor: (s) => s.name,
    selectSession: mockFn(),
    removePane: mockFn(),
    setFocusedPaneId: mockFn(),
    setOpen: mockFn(),
    setSelected: mockFn(),
    setConfirmRemove: mockFn(),
    setRenaming: mockFn(),
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(untrackRepo).mockClear();
});

describe("requestRemoveRepo", () => {
  it("removes straight away when no shell is live", async () => {
    const a = args({ repos: [repo("r", [folder({ dir: "/r", sessions: [session({})] })])] });
    sessionLifecycle(a).requestRemoveRepo(["/r"], "r");
    await vi.waitFor(() => expect(untrackRepo).toHaveBeenCalledWith("/r", "r", [], "agentboard"));
    expect(a.setConfirmRemove).not.toHaveBeenCalled();
  });

  it("asks first when removing would kill a live shell", () => {
    const live = session({ id: "s1", live: true });
    const a = args({ repos: [repo("r", [folder({ dir: "/r", sessions: [live] })])] });
    sessionLifecycle(a).requestRemoveRepo(["/r"], "r");
    expect(a.setConfirmRemove).toHaveBeenCalledWith({
      label: "r",
      dirs: ["/r"],
      sessionIds: ["s1"],
    });
    expect(untrackRepo).not.toHaveBeenCalled();
  });
});

describe("closeFocusedPane", () => {
  it("does nothing when the ring sits on a pane the visible window doesn't hold", () => {
    const a = args({ focusedPaneId: "gone", activePanes: ["s1"] });
    sessionLifecycle(a).closeFocusedPane();
    expect(a.removePane).not.toHaveBeenCalled();
  });

  it("drops a view pane's tile without ending any shell", () => {
    const files = filesPaneId("/r");
    const a = args({ focusedPaneId: files, activePanes: ["s1", files] });
    sessionLifecycle(a).closePane(files);
    expect(a.removePane).toHaveBeenCalledWith(files);
  });
});

describe("closePane", () => {
  it("hands focus to the neighbouring tile when the focused one closes", () => {
    const a = args({
      focusedPaneId: "s1",
      wins: {
        windows: [{ id: "w1", name: "w", folderDir: "/r", panes: ["s1", "s2"] }],
        activeWindows: { "/r": "w1" },
      },
      sessionById: new Map([["s2", session({ id: "s2" })]]),
    });
    sessionLifecycle(a).closePane("s1");
    expect(a.selectSession).toHaveBeenCalledWith("/r", "s2");
    expect(a.removePane).toHaveBeenCalledWith("s1");
  });

  it("clears the ring when the last tile closes", () => {
    const a = args({
      focusedPaneId: "s1",
      wins: {
        windows: [{ id: "w1", name: "w", folderDir: "/r", panes: ["s1"] }],
        activeWindows: { "/r": "w1" },
      },
    });
    sessionLifecycle(a).closePane("s1");
    expect(a.setFocusedPaneId).toHaveBeenCalledWith(null);
  });

  it("moves nothing when an unfocused pane closes", () => {
    const a = args({ focusedPaneId: "s1" });
    sessionLifecycle(a).closePane("s2");
    expect(a.setFocusedPaneId).not.toHaveBeenCalled();
    expect(a.selectSession).not.toHaveBeenCalled();
  });
});

describe("handleExit", () => {
  it("drops the pane and stays quiet for a kill the app asked for", async () => {
    const { toast } = await import("@/lib/toast");
    const expectedKills = { current: new Set(["s1"]) };
    const a = args({ expectedKills });
    sessionLifecycle(a).handleExit("s1", { code: 137, signal: null } as never);
    expect(a.removePane).toHaveBeenCalledWith("s1");
    expect(expectedKills.current.has("s1")).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("commitRename", () => {
  it("ends the rename and skips a blank name", async () => {
    const a = args();
    await sessionLifecycle(a).commitRename("s1", "   ");
    expect(a.setRenaming).toHaveBeenCalledWith(null);
  });
});
