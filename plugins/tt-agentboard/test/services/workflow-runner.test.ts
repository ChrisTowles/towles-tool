import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkPassCondition,
  renderTemplate,
  shellEscape,
} from "../../server/domains/execution/workflow-helpers";

import {
  WorkflowRunner,
  resolveStepComplete,
} from "../../server/domains/execution/workflow-runner";
import {
  createMockDb,
  createMockEventBus,
  createMockLogger,
  createMockTmuxManager,
  createMockSlotAllocator,
  createMockWorkflowLoader,
  createMockContextBundler,
  createMockStreamTailer,
  createMockExecSync,
  setupSelectReturning,
  setupUpdate,
} from "../helpers/mock-deps";
import type { MockDb } from "../helpers/mock-deps";

describe("workflow-helpers", () => {
  describe("checkPassCondition()", () => {
    it("first_line_equals matches when first line equals expected", () => {
      expect(checkPassCondition("first_line_equals:PASS", "PASS\ndetails")).toBe(true);
    });

    it("first_line_equals fails when first line differs", () => {
      expect(checkPassCondition("first_line_equals:PASS", "FAIL\ndetails")).toBe(false);
    });

    it("first_line_equals trims whitespace from first line", () => {
      expect(checkPassCondition("first_line_equals:PASS", "  PASS  \ndetails")).toBe(true);
    });

    it("first_line_equals handles empty content", () => {
      expect(checkPassCondition("first_line_equals:PASS", "")).toBe(false);
    });

    it("contains returns true when content includes substring", () => {
      expect(checkPassCondition("contains:SUCCESS", "the run was a SUCCESS")).toBe(true);
    });

    it("contains returns false when content missing substring", () => {
      expect(checkPassCondition("contains:SUCCESS", "it failed")).toBe(false);
    });

    it("contains is case-sensitive", () => {
      expect(checkPassCondition("contains:SUCCESS", "success")).toBe(false);
    });

    it("unknown format defaults to true", () => {
      expect(checkPassCondition("unknown:format", "anything")).toBe(true);
    });

    it("completely unknown condition defaults to true", () => {
      expect(checkPassCondition("regex:.*", "anything")).toBe(true);
    });
  });

  describe("renderTemplate()", () => {
    it("replaces single variable", () => {
      expect(renderTemplate("{card_id}", { card_id: "42" })).toBe("42");
    });

    it("replaces multiple variables", () => {
      expect(renderTemplate("{card_title} - {issue}", { card_title: "Fix bug", issue: "42" })).toBe(
        "Fix bug - 42",
      );
    });

    it("replaces all occurrences of same variable", () => {
      expect(renderTemplate("{id}-{id}", { id: "1" })).toBe("1-1");
    });

    it("leaves unmatched placeholders as-is", () => {
      expect(renderTemplate("{card_id}-{unknown}", { card_id: "1" })).toBe("1-{unknown}");
    });

    it("handles empty vars", () => {
      expect(renderTemplate("static text", {})).toBe("static text");
    });

    it("handles empty value", () => {
      expect(renderTemplate("issue-{issue}", { issue: "" })).toBe("issue-");
    });
  });

  describe("shellEscape()", () => {
    it("wraps in single quotes", () => {
      expect(shellEscape("hello")).toBe("'hello'");
    });

    it("escapes single quotes within string", () => {
      expect(shellEscape("it's")).toBe("'it'\\''s'");
    });

    it("handles empty string", () => {
      expect(shellEscape("")).toBe("''");
    });

    it("handles multiple single quotes", () => {
      expect(shellEscape("it's a 'test'")).toBe("'it'\\''s a '\\''test'\\'''");
    });

    it("does not escape double quotes", () => {
      expect(shellEscape('say "hi"')).toBe("'say \"hi\"'");
    });
  });
});

describe("resolveStepComplete()", () => {
  it("returns false when no pending callback exists", () => {
    expect(resolveStepComplete(999)).toBe(false);
  });
});

describe("WorkflowRunner", () => {
  let runner: WorkflowRunner;
  let mockDb: MockDb;
  let mockEventBus: ReturnType<typeof createMockEventBus>;
  let mockTmuxManager: ReturnType<typeof createMockTmuxManager>;
  let mockSlotAllocator: ReturnType<typeof createMockSlotAllocator>;
  let mockWorkflowLoader: ReturnType<typeof createMockWorkflowLoader>;

  beforeEach(() => {
    mockDb = createMockDb();
    mockEventBus = createMockEventBus();
    mockTmuxManager = createMockTmuxManager();
    mockSlotAllocator = createMockSlotAllocator();
    mockWorkflowLoader = createMockWorkflowLoader();

    runner = new WorkflowRunner(4200, {
      db: mockDb as never,
      eventBus: mockEventBus,
      logger: createMockLogger(),
      tmuxManager: mockTmuxManager,
      slotAllocator: mockSlotAllocator as never,
      workflowLoader: mockWorkflowLoader as never,
      contextBundler: createMockContextBundler(),
      writeHooks: vi.fn(),
      logCardEvent: vi.fn().mockResolvedValue(undefined),
      streamTailer: createMockStreamTailer(),
      execSync: createMockExecSync() as never,
      existsSync: vi.fn().mockReturnValue(true) as never,
      readFileSync: vi.fn().mockReturnValue("PASS\ndetails") as never,
    });
    vi.clearAllMocks();
  });

  describe("initContext (via run)", () => {
    it("returns early when card not found", async () => {
      setupSelectReturning(mockDb, []);

      await runner.run(999);

      // Should not emit any workflow events since card not found
      expect(mockEventBus.emit).not.toHaveBeenCalledWith("workflow:completed", expect.anything());
    });

    it("marks failed when card has no repoId", async () => {
      const card = { id: 1, repoId: null, workflowId: "plan", title: "Test" };
      setupSelectReturning(mockDb, [card]);
      setupUpdate(mockDb);

      await runner.run(1);

      expect(mockDb.update).toHaveBeenCalled();
      expect(mockEventBus.emit).toHaveBeenCalledWith("card:status-changed", {
        cardId: 1,
        status: "failed",
      });
    });

    it("marks failed when card has no workflowId", async () => {
      const card = { id: 1, repoId: 1, workflowId: null, title: "Test" };
      setupSelectReturning(mockDb, [card]);
      setupUpdate(mockDb);

      await runner.run(1);

      expect(mockEventBus.emit).toHaveBeenCalledWith("card:status-changed", {
        cardId: 1,
        status: "failed",
      });
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

      await runner.run(1);

      expect(mockEventBus.emit).toHaveBeenCalledWith("card:status-changed", {
        cardId: 1,
        status: "failed",
      });
    });

    it("marks failed when tmux not available", async () => {
      const card = { id: 1, repoId: 1, workflowId: "plan", title: "Test" };
      const repo = { id: 1, name: "test-repo", org: "org", defaultBranch: "main" };
      const workflow = { name: "plan", steps: [], branch_template: "ab/card-{card_id}" };

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
      mockTmuxManager.isAvailable.mockReturnValue(false);
      setupUpdate(mockDb);

      await runner.run(1);

      expect(mockEventBus.emit).toHaveBeenCalledWith("card:status-changed", {
        cardId: 1,
        status: "failed",
      });
    });

    it("marks queued when no slots available", async () => {
      const card = { id: 1, repoId: 1, workflowId: "plan", title: "Test" };
      const repo = { id: 1, name: "test-repo", org: "org", defaultBranch: "main" };
      const workflow = { name: "plan", steps: [], branch_template: "ab/card-{card_id}" };

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
      mockTmuxManager.isAvailable.mockReturnValue(true);
      mockSlotAllocator.claimSlot.mockResolvedValue(null);
      setupUpdate(mockDb);

      await runner.run(1);

      expect(mockEventBus.emit).toHaveBeenCalledWith("card:status-changed", {
        cardId: 1,
        status: "queued",
      });
    });
  });
});
