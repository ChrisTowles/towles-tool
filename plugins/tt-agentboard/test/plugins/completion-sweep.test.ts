import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCompletionSweep } from "../../server/plugins/completion-sweep";
import { createMockLogger } from "../helpers/mock-deps";

describe("completion-sweep", () => {
  let mockTmuxManager: {
    listSessions: ReturnType<typeof vi.fn>;
    getPaneCommand: ReturnType<typeof vi.fn>;
  };
  let triggerComplete: ReturnType<typeof vi.fn>;
  let mockDb: ReturnType<typeof createMockDb>;

  function createMockDb(runningCards: Array<{ id: number; status: string }> = []) {
    return {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(runningCards),
        }),
      }),
    };
  }

  beforeEach(() => {
    mockTmuxManager = {
      listSessions: vi.fn().mockReturnValue([]),
      getPaneCommand: vi.fn(),
    };
    triggerComplete = vi.fn().mockResolvedValue(undefined);
    mockDb = createMockDb();
  });

  it("triggers complete for running card with idle tmux session", async () => {
    mockTmuxManager.listSessions.mockReturnValue(["card-1", "card-2"]);
    mockTmuxManager.getPaneCommand.mockReturnValueOnce("zsh").mockReturnValueOnce("node");
    mockDb = createMockDb([
      { id: 1, status: "running" },
      { id: 2, status: "running" },
    ]);

    const { sweep } = createCompletionSweep({
      tmuxManager: mockTmuxManager,
      db: mockDb as never,
      logger: createMockLogger() as never,
      triggerComplete,
    });

    await sweep();

    expect(triggerComplete).toHaveBeenCalledTimes(1);
    expect(triggerComplete).toHaveBeenCalledWith(1);
  });

  it("does nothing when no tmux sessions exist", async () => {
    mockTmuxManager.listSessions.mockReturnValue([]);

    const { sweep } = createCompletionSweep({
      tmuxManager: mockTmuxManager,
      db: mockDb as never,
      logger: createMockLogger() as never,
      triggerComplete,
    });

    await sweep();

    expect(triggerComplete).not.toHaveBeenCalled();
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("skips sessions for cards not in running status", async () => {
    mockTmuxManager.listSessions.mockReturnValue(["card-1"]);
    mockTmuxManager.getPaneCommand.mockReturnValue("zsh");
    // DB returns no running cards
    mockDb = createMockDb([]);

    const { sweep } = createCompletionSweep({
      tmuxManager: mockTmuxManager,
      db: mockDb as never,
      logger: createMockLogger() as never,
      triggerComplete,
    });

    await sweep();

    expect(triggerComplete).not.toHaveBeenCalled();
  });

  it("skips sessions where agent is still running", async () => {
    mockTmuxManager.listSessions.mockReturnValue(["card-1"]);
    mockTmuxManager.getPaneCommand.mockReturnValue("node");
    mockDb = createMockDb([{ id: 1, status: "running" }]);

    const { sweep } = createCompletionSweep({
      tmuxManager: mockTmuxManager,
      db: mockDb as never,
      logger: createMockLogger() as never,
      triggerComplete,
    });

    await sweep();

    expect(triggerComplete).not.toHaveBeenCalled();
  });

  it("handles triggerComplete failure gracefully", async () => {
    mockTmuxManager.listSessions.mockReturnValue(["card-1"]);
    mockTmuxManager.getPaneCommand.mockReturnValue("zsh");
    mockDb = createMockDb([{ id: 1, status: "running" }]);
    triggerComplete.mockRejectedValueOnce(new Error("server down"));

    const { sweep } = createCompletionSweep({
      tmuxManager: mockTmuxManager,
      db: mockDb as never,
      logger: createMockLogger() as never,
      triggerComplete,
    });

    // Should not throw
    await expect(sweep()).resolves.not.toThrow();
  });

  it("skips non-card sessions", async () => {
    mockTmuxManager.listSessions.mockReturnValue(["card-1", "my-session"]);
    mockTmuxManager.getPaneCommand.mockReturnValue("zsh");
    mockDb = createMockDb([{ id: 1, status: "running" }]);

    const { sweep } = createCompletionSweep({
      tmuxManager: mockTmuxManager,
      db: mockDb as never,
      logger: createMockLogger() as never,
      triggerComplete,
    });

    await sweep();

    // Only card-1 should be processed, "my-session" skipped
    expect(triggerComplete).toHaveBeenCalledTimes(1);
    expect(triggerComplete).toHaveBeenCalledWith(1);
  });
});
