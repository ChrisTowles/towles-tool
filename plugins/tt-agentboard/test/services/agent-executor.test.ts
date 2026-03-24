import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing AgentExecutor
vi.mock("../../server/db", () => {
  const mockChain = () => {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn().mockReturnValue(chain);
    chain.where = vi.fn().mockReturnValue(chain);
    chain.set = vi.fn().mockReturnValue(chain);
    chain.limit = vi.fn().mockResolvedValue([]);
    chain.values = vi.fn().mockReturnValue(chain);
    chain.returning = vi.fn().mockResolvedValue([{ id: 1 }]);
    return chain;
  };

  return {
    db: {
      select: vi.fn().mockReturnValue(mockChain()),
      update: vi.fn().mockReturnValue(mockChain()),
      insert: vi.fn().mockReturnValue(mockChain()),
    },
  };
});

vi.mock("../../server/utils/event-bus", () => ({
  eventBus: { emit: vi.fn(), on: vi.fn() },
}));

vi.mock("../../server/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../server/utils/hook-writer", () => ({
  writeHooks: vi.fn(),
}));

vi.mock("../../server/services/tmux-manager", () => ({
  tmuxManager: {
    isAvailable: vi.fn().mockReturnValue(true),
    createSession: vi.fn().mockReturnValue("card-1"),
    startCapture: vi.fn(),
    stopCapture: vi.fn(),
    killSession: vi.fn(),
    sendCommand: vi.fn(),
  },
}));

vi.mock("../../server/services/slot-allocator", () => ({
  slotAllocator: {
    claimSlot: vi.fn().mockResolvedValue({ id: 1, path: "/workspace/slot-1" }),
    releaseSlot: vi.fn(),
  },
}));

vi.mock("../../server/services/workflow-loader", () => ({
  workflowLoader: {
    get: vi.fn().mockReturnValue(null),
  },
}));

vi.mock("../../server/services/workflow-runner", () => ({
  workflowRunner: {
    run: vi.fn().mockResolvedValue(undefined),
  },
}));

// eslint-disable-next-line import/first -- vi.mock must come before imports (vitest hoisting)
import { db } from "../../server/db";
// eslint-disable-next-line import/first
import { eventBus } from "../../server/utils/event-bus";
// eslint-disable-next-line import/first
import { tmuxManager } from "../../server/services/tmux-manager";
// eslint-disable-next-line import/first
import { slotAllocator } from "../../server/services/slot-allocator";
// eslint-disable-next-line import/first
import { workflowLoader } from "../../server/services/workflow-loader";
// eslint-disable-next-line import/first
import { workflowRunner } from "../../server/services/workflow-runner";
// eslint-disable-next-line import/first
import { writeHooks } from "../../server/utils/hook-writer";
// eslint-disable-next-line import/first
import { AgentExecutor } from "../../server/services/agent-executor";

const mockDb = vi.mocked(db);

function setupSelectReturning(rows: unknown[]) {
  const selectChain: Record<string, unknown> = {};
  selectChain.from = vi.fn().mockReturnValue(selectChain);
  selectChain.where = vi.fn().mockResolvedValue(rows);
  mockDb.select = vi.fn().mockReturnValue(selectChain);
}

function setupUpdate() {
  const updateChain: Record<string, unknown> = {};
  updateChain.set = vi.fn().mockReturnValue(updateChain);
  updateChain.where = vi.fn().mockResolvedValue(undefined);
  mockDb.update = vi.fn().mockReturnValue(updateChain);
  return updateChain;
}

function setupInsert() {
  const insertChain: Record<string, unknown> = {};
  insertChain.values = vi.fn().mockReturnValue(insertChain);
  insertChain.returning = vi.fn().mockResolvedValue([{ id: 1 }]);
  mockDb.insert = vi.fn().mockReturnValue(insertChain);
}

describe("AgentExecutor", () => {
  let executor: AgentExecutor;

  beforeEach(() => {
    executor = new AgentExecutor(4200);
    vi.clearAllMocks();
  });

  describe("startExecution()", () => {
    it("returns early when card not found", async () => {
      setupSelectReturning([]);

      await executor.startExecution(999);

      expect(mockDb.update).not.toHaveBeenCalled();
      expect(vi.mocked(eventBus.emit)).not.toHaveBeenCalled();
    });

    it("marks failed when card has no repoId", async () => {
      const card = { id: 1, repoId: null, workflowId: null, title: "Test" };
      setupSelectReturning([card]);
      setupUpdate();

      await executor.startExecution(1);

      expect(vi.mocked(eventBus.emit)).toHaveBeenCalledWith("card:status-changed", {
        cardId: 1,
        status: "failed",
      });
    });

    it("delegates to workflowRunner when card has valid workflow", async () => {
      const card = { id: 1, repoId: 1, workflowId: "plan", title: "Test" };
      setupSelectReturning([card]);

      const workflow = { name: "plan", steps: [] };
      vi.mocked(workflowLoader.get).mockReturnValue(workflow as never);

      await executor.startExecution(1);

      expect(vi.mocked(workflowRunner.run)).toHaveBeenCalledWith(1);
    });

    it("falls back to single prompt when workflow not found", async () => {
      const card = {
        id: 1,
        repoId: 1,
        workflowId: "nonexistent",
        title: "Test Card",
        description: "Do something",
        executionMode: "headless",
      };
      setupSelectReturning([card]);
      setupUpdate();
      setupInsert();

      vi.mocked(workflowLoader.get).mockReturnValue(undefined as never);
      vi.mocked(tmuxManager.isAvailable).mockReturnValue(true);
      vi.mocked(slotAllocator.claimSlot).mockResolvedValue({
        id: 1,
        path: "/workspace/slot-1",
      } as never);

      await executor.startExecution(1);

      expect(vi.mocked(workflowRunner.run)).not.toHaveBeenCalled();
      expect(vi.mocked(tmuxManager.sendCommand)).toHaveBeenCalled();
    });

    it("marks queued when no slots available", async () => {
      const card = {
        id: 1,
        repoId: 1,
        workflowId: null,
        title: "Test",
        executionMode: "headless",
      };
      setupSelectReturning([card]);
      setupUpdate();

      vi.mocked(tmuxManager.isAvailable).mockReturnValue(true);
      vi.mocked(slotAllocator.claimSlot).mockResolvedValue(null);

      await executor.startExecution(1);

      expect(vi.mocked(eventBus.emit)).toHaveBeenCalledWith("card:status-changed", {
        cardId: 1,
        status: "queued",
      });
    });

    it("marks failed when tmux not available", async () => {
      const card = {
        id: 1,
        repoId: 1,
        workflowId: null,
        title: "Test",
        executionMode: "headless",
      };
      setupSelectReturning([card]);
      setupUpdate();

      vi.mocked(tmuxManager.isAvailable).mockReturnValue(false);

      await executor.startExecution(1);

      expect(vi.mocked(eventBus.emit)).toHaveBeenCalledWith("card:status-changed", {
        cardId: 1,
        status: "failed",
      });
    });

    it("writes hooks and starts capture on successful single-prompt", async () => {
      const card = {
        id: 1,
        repoId: 1,
        workflowId: null,
        title: "Test Card",
        description: "Implement feature",
        executionMode: "headless",
      };
      setupSelectReturning([card]);
      setupUpdate();
      setupInsert();

      vi.mocked(tmuxManager.isAvailable).mockReturnValue(true);
      vi.mocked(slotAllocator.claimSlot).mockResolvedValue({
        id: 1,
        path: "/workspace/slot-1",
      } as never);

      await executor.startExecution(1);

      expect(vi.mocked(writeHooks)).toHaveBeenCalledWith("/workspace/slot-1", 1, 4200, "complete");
      expect(vi.mocked(tmuxManager.createSession)).toHaveBeenCalledWith(1, "/workspace/slot-1");
      expect(vi.mocked(tmuxManager.startCapture)).toHaveBeenCalled();
      expect(vi.mocked(tmuxManager.sendCommand)).toHaveBeenCalledWith(
        "card-1",
        expect.stringContaining("claude -p"),
      );
    });

    it("uses --dangerously-skip-permissions for headless mode", async () => {
      const card = {
        id: 1,
        repoId: 1,
        workflowId: null,
        title: "Test",
        description: null,
        executionMode: "headless",
      };
      setupSelectReturning([card]);
      setupUpdate();
      setupInsert();

      vi.mocked(tmuxManager.isAvailable).mockReturnValue(true);
      vi.mocked(slotAllocator.claimSlot).mockResolvedValue({
        id: 1,
        path: "/workspace/slot-1",
      } as never);

      await executor.startExecution(1);

      const sendCommandCall = vi.mocked(tmuxManager.sendCommand).mock.calls[0]!;
      expect(sendCommandCall[1]).toContain("--dangerously-skip-permissions");
    });

    it("omits --dangerously-skip-permissions for interactive mode", async () => {
      const card = {
        id: 1,
        repoId: 1,
        workflowId: null,
        title: "Test",
        description: "do stuff",
        executionMode: "interactive",
      };
      setupSelectReturning([card]);
      setupUpdate();
      setupInsert();

      vi.mocked(tmuxManager.isAvailable).mockReturnValue(true);
      vi.mocked(slotAllocator.claimSlot).mockResolvedValue({
        id: 1,
        path: "/workspace/slot-1",
      } as never);

      await executor.startExecution(1);

      const sendCommandCall = vi.mocked(tmuxManager.sendCommand).mock.calls[0]!;
      expect(sendCommandCall[1]).not.toContain("--dangerously-skip-permissions");
    });

    it("uses card title as prompt when description is null", async () => {
      const card = {
        id: 1,
        repoId: 1,
        workflowId: null,
        title: "Fix the bug",
        description: null,
        executionMode: "headless",
      };
      setupSelectReturning([card]);
      setupUpdate();
      setupInsert();

      vi.mocked(tmuxManager.isAvailable).mockReturnValue(true);
      vi.mocked(slotAllocator.claimSlot).mockResolvedValue({
        id: 1,
        path: "/workspace/slot-1",
      } as never);

      await executor.startExecution(1);

      const sendCommandCall = vi.mocked(tmuxManager.sendCommand).mock.calls[0]!;
      expect(sendCommandCall[1]).toContain("Fix the bug");
    });
  });
});
