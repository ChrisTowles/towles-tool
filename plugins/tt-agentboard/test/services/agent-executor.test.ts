import { describe, it, expect, vi, beforeEach } from "vitest";

import { AgentExecutor } from "../../server/domains/execution/agent-executor";
import {
  createMockDb,
  createMockEventBus,
  createMockLogger,
  createMockTmuxManager,
  createMockSlotAllocator,
  createMockWorkflowLoader,
  createMockWorkflowRunner,
  createMockStreamTailer,
  createMockExecSync,
  setupSelectReturning,
  setupUpdate,
  setupInsert,
} from "../helpers/mock-deps";
import type { MockDb } from "../helpers/mock-deps";

describe("AgentExecutor", () => {
  let executor: AgentExecutor;
  let mockDb: MockDb;
  let mockEventBus: ReturnType<typeof createMockEventBus>;
  let mockTmuxManager: ReturnType<typeof createMockTmuxManager>;
  let mockSlotAllocator: ReturnType<typeof createMockSlotAllocator>;
  let mockWorkflowLoader: ReturnType<typeof createMockWorkflowLoader>;
  let mockWorkflowRunner: ReturnType<typeof createMockWorkflowRunner>;
  let mockWriteHooks: ReturnType<typeof vi.fn>;
  let mockLogCardEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockDb = createMockDb();
    mockEventBus = createMockEventBus();
    mockTmuxManager = createMockTmuxManager();
    mockSlotAllocator = createMockSlotAllocator();
    mockWorkflowLoader = createMockWorkflowLoader();
    mockWorkflowRunner = createMockWorkflowRunner();
    mockWriteHooks = vi.fn();
    mockLogCardEvent = vi.fn().mockResolvedValue(undefined);

    executor = new AgentExecutor(4200, {
      db: mockDb as never,
      eventBus: mockEventBus,
      logger: createMockLogger(),
      tmuxManager: mockTmuxManager,
      slotAllocator: mockSlotAllocator as never,
      workflowLoader: mockWorkflowLoader,
      workflowRunner: mockWorkflowRunner,
      writeHooks: mockWriteHooks as never,
      logCardEvent: mockLogCardEvent as never,
      streamTailer: createMockStreamTailer(),
      execSync: createMockExecSync() as never,
      existsSync: vi.fn().mockReturnValue(false) as never,
    });
    vi.clearAllMocks();
  });

  describe("startExecution()", () => {
    it("returns early when card not found", async () => {
      setupSelectReturning(mockDb, []);

      await executor.startExecution(999);

      expect(mockDb.update).not.toHaveBeenCalled();
      expect(mockEventBus.emit).not.toHaveBeenCalled();
    });

    it("marks failed when card has no repoId", async () => {
      const card = { id: 1, repoId: null, workflowId: null, title: "Test" };
      setupSelectReturning(mockDb, [card]);
      setupUpdate(mockDb);

      await executor.startExecution(1);

      expect(mockEventBus.emit).toHaveBeenCalledWith("card:status-changed", {
        cardId: 1,
        status: "failed",
      });
    });

    it("delegates to workflowRunner when card has valid workflow", async () => {
      const card = { id: 1, repoId: 1, workflowId: "plan", title: "Test" };
      setupSelectReturning(mockDb, [card]);

      const workflow = { name: "plan", steps: [] };
      mockWorkflowLoader.get.mockReturnValue(workflow as never);

      await executor.startExecution(1);

      expect(mockWorkflowRunner.run).toHaveBeenCalledWith(1);
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
      setupSelectReturning(mockDb, [card]);
      setupUpdate(mockDb);
      setupInsert(mockDb);

      mockWorkflowLoader.get.mockReturnValue(undefined as never);
      mockTmuxManager.isAvailable.mockReturnValue(true);
      mockSlotAllocator.claimSlot.mockResolvedValue({
        id: 1,
        path: "/workspace/slot-1",
      } as never);

      await executor.startExecution(1);

      expect(mockWorkflowRunner.run).not.toHaveBeenCalled();
      expect(mockTmuxManager.sendCommand).toHaveBeenCalled();
    });

    it("marks queued when no slots available", async () => {
      const card = {
        id: 1,
        repoId: 1,
        workflowId: null,
        title: "Test",
        executionMode: "headless",
      };
      setupSelectReturning(mockDb, [card]);
      setupUpdate(mockDb);

      mockTmuxManager.isAvailable.mockReturnValue(true);
      mockSlotAllocator.claimSlot.mockResolvedValue(null);

      await executor.startExecution(1);

      expect(mockEventBus.emit).toHaveBeenCalledWith("card:status-changed", {
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
      setupSelectReturning(mockDb, [card]);
      setupUpdate(mockDb);

      mockTmuxManager.isAvailable.mockReturnValue(false);

      await executor.startExecution(1);

      expect(mockEventBus.emit).toHaveBeenCalledWith("card:status-changed", {
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
      setupSelectReturning(mockDb, [card]);
      setupUpdate(mockDb);
      setupInsert(mockDb);

      mockTmuxManager.isAvailable.mockReturnValue(true);
      mockSlotAllocator.claimSlot.mockResolvedValue({
        id: 1,
        path: "/workspace/slot-1",
      } as never);

      await executor.startExecution(1);

      expect(mockWriteHooks).toHaveBeenCalledWith("/workspace/slot-1", 1, 4200, "complete");
      expect(mockTmuxManager.createSession).toHaveBeenCalledWith(1, "/workspace/slot-1");
      expect(mockTmuxManager.startCapture).toHaveBeenCalled();
      const cmd = mockTmuxManager.sendCommand.mock.calls[0]![1] as string;
      expect(cmd).toContain("claude");
      expect(cmd).toContain("-p");
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
      setupSelectReturning(mockDb, [card]);
      setupUpdate(mockDb);
      setupInsert(mockDb);

      mockTmuxManager.isAvailable.mockReturnValue(true);
      mockSlotAllocator.claimSlot.mockResolvedValue({
        id: 1,
        path: "/workspace/slot-1",
      } as never);

      await executor.startExecution(1);

      const sendCommandCall = mockTmuxManager.sendCommand.mock.calls[0]!;
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
      setupSelectReturning(mockDb, [card]);
      setupUpdate(mockDb);
      setupInsert(mockDb);

      mockTmuxManager.isAvailable.mockReturnValue(true);
      mockSlotAllocator.claimSlot.mockResolvedValue({
        id: 1,
        path: "/workspace/slot-1",
      } as never);

      await executor.startExecution(1);

      const sendCommandCall = mockTmuxManager.sendCommand.mock.calls[0]!;
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
      setupSelectReturning(mockDb, [card]);
      setupUpdate(mockDb);
      setupInsert(mockDb);

      mockTmuxManager.isAvailable.mockReturnValue(true);
      mockSlotAllocator.claimSlot.mockResolvedValue({
        id: 1,
        path: "/workspace/slot-1",
      } as never);

      await executor.startExecution(1);

      const sendCommandCall = mockTmuxManager.sendCommand.mock.calls[0]!;
      expect(sendCommandCall[1]).toContain("Fix the bug");
    });
  });
});
