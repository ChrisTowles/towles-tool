import { describe, it, expect, vi, beforeEach } from "vitest";

import { AgentExecutor } from "../../server/domains/execution/agent-executor";
import {
  createMockDb,
  createMockEventBus,
  createMockLogger,
  createMockTmuxManager,
  createMockSlotAllocator,
  createMockWorkflowLoader,
  createMockWorkflowOrchestrator,
  createMockExecSync,
  createMockCardService,
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
  let mockWorkflowOrchestrator: ReturnType<typeof createMockWorkflowOrchestrator>;
  let mockWriteHooks: ReturnType<typeof vi.fn>;
  let mockCardService: ReturnType<typeof createMockCardService>;

  beforeEach(() => {
    mockDb = createMockDb();
    mockEventBus = createMockEventBus();
    mockTmuxManager = createMockTmuxManager();
    mockSlotAllocator = createMockSlotAllocator();
    mockWorkflowLoader = createMockWorkflowLoader();
    mockWorkflowOrchestrator = createMockWorkflowOrchestrator();
    mockWriteHooks = vi.fn();
    mockCardService = createMockCardService();

    executor = new AgentExecutor(4200, {
      db: mockDb as never,
      eventBus: mockEventBus,
      logger: createMockLogger(),
      tmuxManager: mockTmuxManager,
      slotAllocator: mockSlotAllocator as never,
      workflowLoader: mockWorkflowLoader,
      workflowOrchestrator: mockWorkflowOrchestrator,
      writeHooks: mockWriteHooks as never,
      cardService: mockCardService as never,
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
      expect(mockCardService.updateStatus).not.toHaveBeenCalled();
    });

    it("marks failed when card has no repoId", async () => {
      const card = { id: 1, repoId: null, workflowId: null, title: "Test" };
      setupSelectReturning(mockDb, [card]);
      setupUpdate(mockDb);

      await executor.startExecution(1);

      expect(mockCardService.updateStatus).toHaveBeenCalledWith(1, "failed");
    });

    it("delegates to workflowRunner when card has valid workflow", async () => {
      const card = { id: 1, repoId: 1, workflowId: "plan", title: "Test" };
      setupSelectReturning(mockDb, [card]);

      const workflow = { name: "plan", steps: [] };
      mockWorkflowLoader.get.mockReturnValue(workflow as never);

      await executor.startExecution(1);

      expect(mockWorkflowOrchestrator.run).toHaveBeenCalledWith(1);
    });

    it("falls back to single prompt when workflow not found", async () => {
      const card = {
        id: 1,
        repoId: 1,
        workflowId: "nonexistent",
        title: "Test Card",
        description: "Do something",
        executionMode: "auto-claude",
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

      expect(mockWorkflowOrchestrator.run).not.toHaveBeenCalled();
      expect(mockTmuxManager.sendCommand).toHaveBeenCalled();
    });

    it("marks queued when no slots available", async () => {
      const card = {
        id: 1,
        repoId: 1,
        workflowId: null,
        title: "Test",
        executionMode: "auto-claude",
      };
      setupSelectReturning(mockDb, [card]);
      setupUpdate(mockDb);

      mockTmuxManager.isAvailable.mockReturnValue(true);
      mockSlotAllocator.claimSlot.mockResolvedValue(null);

      await executor.startExecution(1);

      expect(mockCardService.updateStatus).toHaveBeenCalledWith(1, "queued");
    });

    it("marks failed when tmux not available", async () => {
      const card = {
        id: 1,
        repoId: 1,
        workflowId: null,
        title: "Test",
        executionMode: "auto-claude",
      };
      setupSelectReturning(mockDb, [card]);
      setupUpdate(mockDb);

      mockTmuxManager.isAvailable.mockReturnValue(false);

      await executor.startExecution(1);

      expect(mockCardService.updateStatus).toHaveBeenCalledWith(1, "failed");
    });

    it("writes hooks and starts capture on successful single-prompt", async () => {
      const card = {
        id: 1,
        repoId: 1,
        workflowId: null,
        title: "Test Card",
        description: "Implement feature",
        executionMode: "auto-claude",
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
      expect(cmd).toContain("tt auto-claude");
      expect(cmd).toContain("Implement feature");
    });

    it("uses tt auto-claude for auto-claude mode", async () => {
      const card = {
        id: 1,
        repoId: 1,
        workflowId: null,
        title: "Test",
        description: null,
        executionMode: "auto-claude",
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
      expect(sendCommandCall[1]).toContain("tt auto-claude");
    });

    it("uses raw claude for claude mode", async () => {
      const card = {
        id: 1,
        repoId: 1,
        workflowId: null,
        title: "Test",
        description: "do stuff",
        executionMode: "claude",
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
      expect(sendCommandCall[1]).toContain("claude");
      expect(sendCommandCall[1]).not.toContain("tt auto-claude");
    });

    it("uses card title as prompt when description is null", async () => {
      const card = {
        id: 1,
        repoId: 1,
        workflowId: null,
        title: "Fix the bug",
        description: null,
        executionMode: "auto-claude",
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
