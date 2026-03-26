import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkPassCondition,
  renderTemplate,
  shellEscape,
} from "../../server/utils/workflow-helpers";

// Mock dependencies before importing WorkflowRunner
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
    createSession: vi.fn().mockReturnValue({ sessionName: "card-1", created: true }),
    startCapture: vi.fn(),
    stopCapture: vi.fn(),
    killSession: vi.fn(),
    sendCommand: vi.fn(),
  },
}));

vi.mock("../../server/services/slot-allocator", () => ({
  slotAllocator: {
    claimSlot: vi.fn().mockResolvedValue({ id: 1, path: "/workspace/slot-1" }),
    releaseSlot: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../server/services/workflow-loader", () => ({
  workflowLoader: {
    get: vi.fn().mockReturnValue(null),
  },
}));

vi.mock("../../server/services/context-bundler", () => ({
  contextBundler: {
    buildPrompt: vi.fn().mockReturnValue("test prompt"),
  },
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue("PASS\ndetails"),
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
import { WorkflowRunner, resolveStepComplete } from "../../server/services/workflow-runner";

const mockDb = vi.mocked(db);

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

  beforeEach(() => {
    runner = new WorkflowRunner(4200);
    vi.clearAllMocks();
  });

  describe("initContext (via run)", () => {
    it("returns early when card not found", async () => {
      const selectChain: Record<string, unknown> = {};
      selectChain.from = vi.fn().mockReturnValue(selectChain);
      selectChain.where = vi.fn().mockResolvedValue([]);
      mockDb.select = vi.fn().mockReturnValue(selectChain);

      await runner.run(999);

      // Should not emit any workflow events since card not found
      expect(vi.mocked(eventBus.emit)).not.toHaveBeenCalledWith(
        "workflow:completed",
        expect.anything(),
      );
    });

    it("marks failed when card has no repoId", async () => {
      const card = { id: 1, repoId: null, workflowId: "plan", title: "Test" };

      const selectChain: Record<string, unknown> = {};
      selectChain.from = vi.fn().mockReturnValue(selectChain);
      selectChain.where = vi.fn().mockResolvedValue([card]);
      mockDb.select = vi.fn().mockReturnValue(selectChain);

      const updateChain: Record<string, unknown> = {};
      updateChain.set = vi.fn().mockReturnValue(updateChain);
      updateChain.where = vi.fn().mockResolvedValue(undefined);
      mockDb.update = vi.fn().mockReturnValue(updateChain);

      await runner.run(1);

      expect(mockDb.update).toHaveBeenCalled();
      expect(vi.mocked(eventBus.emit)).toHaveBeenCalledWith("card:status-changed", {
        cardId: 1,
        status: "failed",
      });
    });

    it("marks failed when card has no workflowId", async () => {
      const card = { id: 1, repoId: 1, workflowId: null, title: "Test" };

      const selectChain: Record<string, unknown> = {};
      selectChain.from = vi.fn().mockReturnValue(selectChain);
      selectChain.where = vi.fn().mockResolvedValue([card]);
      mockDb.select = vi.fn().mockReturnValue(selectChain);

      const updateChain: Record<string, unknown> = {};
      updateChain.set = vi.fn().mockReturnValue(updateChain);
      updateChain.where = vi.fn().mockResolvedValue(undefined);
      mockDb.update = vi.fn().mockReturnValue(updateChain);

      await runner.run(1);

      expect(vi.mocked(eventBus.emit)).toHaveBeenCalledWith("card:status-changed", {
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

      vi.mocked(workflowLoader.get).mockReturnValue(undefined as never);

      const updateChain: Record<string, unknown> = {};
      updateChain.set = vi.fn().mockReturnValue(updateChain);
      updateChain.where = vi.fn().mockResolvedValue(undefined);
      mockDb.update = vi.fn().mockReturnValue(updateChain);

      await runner.run(1);

      expect(vi.mocked(eventBus.emit)).toHaveBeenCalledWith("card:status-changed", {
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

      vi.mocked(workflowLoader.get).mockReturnValue(workflow as never);
      vi.mocked(tmuxManager.isAvailable).mockReturnValue(false);

      const updateChain: Record<string, unknown> = {};
      updateChain.set = vi.fn().mockReturnValue(updateChain);
      updateChain.where = vi.fn().mockResolvedValue(undefined);
      mockDb.update = vi.fn().mockReturnValue(updateChain);

      await runner.run(1);

      expect(vi.mocked(eventBus.emit)).toHaveBeenCalledWith("card:status-changed", {
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

      vi.mocked(workflowLoader.get).mockReturnValue(workflow as never);
      vi.mocked(tmuxManager.isAvailable).mockReturnValue(true);
      vi.mocked(slotAllocator.claimSlot).mockResolvedValue(null);

      const updateChain: Record<string, unknown> = {};
      updateChain.set = vi.fn().mockReturnValue(updateChain);
      updateChain.where = vi.fn().mockResolvedValue(undefined);
      mockDb.update = vi.fn().mockReturnValue(updateChain);

      await runner.run(1);

      expect(vi.mocked(eventBus.emit)).toHaveBeenCalledWith("card:status-changed", {
        cardId: 1,
        status: "queued",
      });
    });
  });
});
