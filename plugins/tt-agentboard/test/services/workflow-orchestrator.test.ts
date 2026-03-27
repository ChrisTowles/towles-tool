import { describe, it, expect, vi, beforeEach } from "vitest";

import { WorkflowOrchestrator } from "../../server/domains/execution/workflow-orchestrator";
import {
  createMockDb,
  createMockEventBus,
  createMockLogger,
  createMockTmuxManager,
  createMockSlotAllocator,
  createMockWorkflowLoader,
  createMockContextBundler,
  createMockCardService,
  createMockStreamTailer,
  createMockExecSync,
  createMockStepExecutor,
  setupSelectReturning,
  setupUpdate,
} from "../helpers/mock-deps";
import type { MockDb } from "../helpers/mock-deps";

function setupInitContext(
  mockDb: MockDb,
  mockWorkflowLoader: ReturnType<typeof createMockWorkflowLoader>,
  opts: {
    card?: Record<string, unknown>;
    repo?: Record<string, unknown>;
    workflow?: Record<string, unknown>;
  } = {},
) {
  const card = opts.card ?? {
    id: 1,
    repoId: 1,
    workflowId: "plan",
    title: "Test",
    branchMode: "create",
    githubIssueNumber: 42,
  };
  const repo = opts.repo ?? { id: 1, name: "test-repo", org: "org", defaultBranch: "main" };
  const workflow = opts.workflow ?? {
    name: "plan",
    steps: [{ id: "plan", prompt_template: "Plan", artifact: "plan.md" }],
    branch_template: "ab/card-{card_id}",
  };

  let selectCount = 0;
  mockDb.select = vi.fn().mockImplementation(() => {
    selectCount++;
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn().mockReturnValue(chain);
    if (selectCount === 1) {
      chain.where = vi.fn().mockResolvedValue([card]);
    } else {
      chain.where = vi.fn().mockResolvedValue([repo]);
    }
    return chain;
  });

  mockWorkflowLoader.get.mockReturnValue(workflow as never);

  // Setup insert for workflowRuns
  const insertChain: Record<string, unknown> = {};
  insertChain.values = vi.fn().mockReturnValue(insertChain);
  insertChain.returning = vi.fn().mockResolvedValue([{ id: 1 }]);
  mockDb.insert = vi.fn().mockReturnValue(insertChain);

  // Setup update
  setupUpdate(mockDb);
}

describe("WorkflowOrchestrator", () => {
  let orchestrator: WorkflowOrchestrator;
  let mockDb: MockDb;
  let mockEventBus: ReturnType<typeof createMockEventBus>;
  let mockTmuxManager: ReturnType<typeof createMockTmuxManager>;
  let mockSlotAllocator: ReturnType<typeof createMockSlotAllocator>;
  let mockWorkflowLoader: ReturnType<typeof createMockWorkflowLoader>;
  let mockCardService: ReturnType<typeof createMockCardService>;
  let mockStepExecutor: ReturnType<typeof createMockStepExecutor>;
  let mockExecSync: ReturnType<typeof createMockExecSync>;

  beforeEach(() => {
    mockDb = createMockDb();
    mockEventBus = createMockEventBus();
    mockTmuxManager = createMockTmuxManager();
    mockSlotAllocator = createMockSlotAllocator();
    mockWorkflowLoader = createMockWorkflowLoader();
    mockCardService = createMockCardService();
    mockStepExecutor = createMockStepExecutor();
    mockExecSync = createMockExecSync();

    orchestrator = new WorkflowOrchestrator({
      db: mockDb as never,
      eventBus: mockEventBus,
      logger: createMockLogger(),
      tmuxManager: mockTmuxManager,
      slotAllocator: mockSlotAllocator as never,
      workflowLoader: mockWorkflowLoader as never,
      contextBundler: createMockContextBundler(),
      cardService: mockCardService as never,
      stepExecutor: mockStepExecutor as never,
      streamTailer: createMockStreamTailer(),
      execSync: mockExecSync as never,
    });
    vi.clearAllMocks();
  });

  describe("initContext (via run)", () => {
    it("returns early when card not found", async () => {
      setupSelectReturning(mockDb, []);

      await orchestrator.run(999);

      expect(mockEventBus.emit).not.toHaveBeenCalledWith("workflow:completed", expect.anything());
    });

    it("marks failed when card has no repoId", async () => {
      const card = { id: 1, repoId: null, workflowId: "plan", title: "Test" };
      setupSelectReturning(mockDb, [card]);
      setupUpdate(mockDb);

      await orchestrator.run(1);

      expect(mockCardService.updateStatus).toHaveBeenCalledWith(1, "failed");
    });

    it("marks failed when card has no workflowId", async () => {
      const card = { id: 1, repoId: 1, workflowId: null, title: "Test" };
      setupSelectReturning(mockDb, [card]);
      setupUpdate(mockDb);

      await orchestrator.run(1);

      expect(mockCardService.updateStatus).toHaveBeenCalledWith(1, "failed");
    });

    it("marks failed when workflow not found", async () => {
      const card = { id: 1, repoId: 1, workflowId: "nonexistent", title: "Test" };
      const repo = { id: 1, name: "test-repo", org: "org", defaultBranch: "main" };

      let selectCount = 0;
      mockDb.select = vi.fn().mockImplementation(() => {
        selectCount++;
        const chain: Record<string, unknown> = {};
        chain.from = vi.fn().mockReturnValue(chain);
        if (selectCount === 1) {
          chain.where = vi.fn().mockResolvedValue([card]);
        } else {
          chain.where = vi.fn().mockResolvedValue([repo]);
        }
        return chain;
      });

      mockWorkflowLoader.get.mockReturnValue(undefined as never);
      setupUpdate(mockDb);

      await orchestrator.run(1);

      expect(mockCardService.updateStatus).toHaveBeenCalledWith(1, "failed");
    });

    it("marks failed when tmux not available", async () => {
      setupInitContext(mockDb, mockWorkflowLoader);
      mockTmuxManager.isAvailable.mockReturnValue(false);

      await orchestrator.run(1);

      expect(mockCardService.updateStatus).toHaveBeenCalledWith(1, "failed");
    });

    it("marks queued when no slots available", async () => {
      setupInitContext(mockDb, mockWorkflowLoader);
      mockSlotAllocator.claimSlot.mockResolvedValue(null);

      await orchestrator.run(1);

      expect(mockCardService.updateStatus).toHaveBeenCalledWith(1, "queued");
    });
  });

  describe("step execution", () => {
    it("runs all steps in order when all pass", async () => {
      const workflow = {
        name: "multi",
        steps: [
          { id: "plan", prompt_template: "Plan", artifact: "plan.md" },
          { id: "implement", prompt_template: "Implement", artifact: "impl.md" },
        ],
        branch_template: "ab/card-{card_id}",
      };
      setupInitContext(mockDb, mockWorkflowLoader, { workflow });
      mockStepExecutor.execute.mockResolvedValue({ passed: true, artifact: "content" });

      await orchestrator.run(1);

      expect(mockStepExecutor.execute).toHaveBeenCalledTimes(2);
      expect(mockCardService.markComplete).toHaveBeenCalledWith(1);
      expect(mockEventBus.emit).toHaveBeenCalledWith(
        "workflow:completed",
        expect.objectContaining({ cardId: 1, status: "completed" }),
      );
    });

    it("stops on step failure", async () => {
      const workflow = {
        name: "multi",
        steps: [
          { id: "plan", prompt_template: "Plan", artifact: "plan.md" },
          { id: "implement", prompt_template: "Implement", artifact: "impl.md" },
        ],
        branch_template: "ab/card-{card_id}",
      };
      setupInitContext(mockDb, mockWorkflowLoader, { workflow });
      mockStepExecutor.execute.mockResolvedValueOnce({ passed: false });

      await orchestrator.run(1);

      // Only the first step should be executed
      expect(mockStepExecutor.execute).toHaveBeenCalledTimes(1);
      expect(mockCardService.markComplete).not.toHaveBeenCalled();
      expect(mockCardService.updateStatus).toHaveBeenCalledWith(1, "failed");
      expect(mockEventBus.emit).toHaveBeenCalledWith(
        "workflow:completed",
        expect.objectContaining({ cardId: 1, status: "failed" }),
      );
    });
  });

  describe("cleanup", () => {
    it("cleans up in finally block (releases slot, kills tmux)", async () => {
      setupInitContext(mockDb, mockWorkflowLoader);
      mockStepExecutor.execute.mockResolvedValue({ passed: true });

      await orchestrator.run(1);

      expect(mockTmuxManager.stopCapture).toHaveBeenCalledWith("card-1");
      expect(mockTmuxManager.killSession).toHaveBeenCalledWith("card-1");
      expect(mockSlotAllocator.releaseSlot).toHaveBeenCalledWith(1);
    });

    it("cleans up even when step throws", async () => {
      setupInitContext(mockDb, mockWorkflowLoader);
      mockStepExecutor.execute.mockRejectedValue(new Error("boom"));

      await orchestrator.run(1);

      expect(mockTmuxManager.killSession).toHaveBeenCalledWith("card-1");
      expect(mockSlotAllocator.releaseSlot).toHaveBeenCalledWith(1);
      expect(mockCardService.updateStatus).toHaveBeenCalledWith(1, "failed");
    });
  });
});
