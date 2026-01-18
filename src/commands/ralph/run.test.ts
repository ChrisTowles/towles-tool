/**
 * Unit tests for ralph-loop script
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RalphPlan, IterationHistory } from "../../lib/ralph/index.js";
import {
  createInitialState,
  saveState,
  loadState,
  addPlanToState,
  formatPlansAsMarkdown,
  formatPlanAsMarkdown,
  formatPlanAsJson,
  buildIterationPrompt,
  extractOutputSummary,
  detectCompletionMarker,
  appendHistory,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_STATE_FILE,
  DEFAULT_HISTORY_FILE,
  DEFAULT_COMPLETION_MARKER,
  CLAUDE_DEFAULT_ARGS,
} from "../../lib/ralph/index.js";

describe("ralph-loop", () => {
  const testStateFile = join(tmpdir(), `ralph-test-${Date.now()}.json`);
  const testHistoryFile = join(tmpdir(), `ralph-history-${Date.now()}.log`);

  afterEach(() => {
    // Cleanup test files
    if (existsSync(testStateFile)) {
      unlinkSync(testStateFile);
    }
    if (existsSync(testHistoryFile)) {
      unlinkSync(testHistoryFile);
    }
  });

  describe("constants", () => {
    it("should have correct default values", () => {
      expect(DEFAULT_MAX_ITERATIONS).toBe(10);
      expect(DEFAULT_STATE_FILE).toBe("./.claude/.ralph/ralph-state.local.json");
      expect(DEFAULT_HISTORY_FILE).toBe("./.claude/.ralph/ralph-history.local.log");
      expect(DEFAULT_COMPLETION_MARKER).toBe("RALPH_DONE");
      expect(CLAUDE_DEFAULT_ARGS).toEqual([
        "--print",
        "--verbose",
        "--output-format",
        "stream-json",
        "--permission-mode",
        "bypassPermissions",
      ]);
    });
  });

  describe("createInitialState", () => {
    it("should create state with correct structure", () => {
      const state = createInitialState();

      expect(state.version).toBe(1);
      expect(state.status).toBe("running");
      expect(state.plans).toEqual([]);
      expect(state.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("saveState and loadState", () => {
    it("should save and load state correctly", () => {
      const state = createInitialState();
      addPlanToState(state, "test plan");

      saveState(state, testStateFile);
      const loaded = loadState(testStateFile);

      expect(loaded).not.toBeNull();
      expect(loaded?.plans).toHaveLength(1);
      expect(loaded?.plans[0].description).toBe("test plan");
    });

    it("should return null for non-existent file", () => {
      const loaded = loadState("/nonexistent/path/file.json");
      expect(loaded).toBeNull();
    });

    it("should return null for invalid JSON", () => {
      writeFileSync(testStateFile, "invalid json {{{");
      const loaded = loadState(testStateFile);
      expect(loaded).toBeNull();
    });
  });

  describe("buildIterationPrompt", () => {
    const testPlan: RalphPlan = {
      id: 1,
      description: "First plan",
      status: "ready",
      addedAt: new Date().toISOString(),
    };

    it("should include completion marker", () => {
      const prompt = buildIterationPrompt({ completionMarker: "RALPH_DONE", plan: testPlan });
      expect(prompt).toContain("RALPH_DONE");
    });

    it("should include plan id and description", () => {
      const prompt = buildIterationPrompt({ completionMarker: "RALPH_DONE", plan: testPlan });
      expect(prompt).toContain("#1: First plan");
    });

    it("should include mark done command with plan id", () => {
      const prompt = buildIterationPrompt({ completionMarker: "RALPH_DONE", plan: testPlan });
      expect(prompt).toContain("tt ralph plan done 1");
    });

    it("should include custom completion marker", () => {
      const prompt = buildIterationPrompt({ completionMarker: "CUSTOM_MARKER", plan: testPlan });
      expect(prompt).toContain("CUSTOM_MARKER");
    });
  });

  describe("extractOutputSummary", () => {
    it("should return last 5 lines joined", () => {
      const output = "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7";
      const summary = extractOutputSummary(output);

      expect(summary).toContain("line 3");
      expect(summary).toContain("line 7");
      expect(summary).not.toContain("line 1");
      expect(summary).not.toContain("line 2");
    });

    it("should filter empty lines", () => {
      const output = "line 1\n\n\nline 2\n\nline 3";
      const summary = extractOutputSummary(output);

      expect(summary).toBe("line 1 line 2 line 3");
    });

    it("should truncate long output", () => {
      const longLine = "x".repeat(300);
      const summary = extractOutputSummary(longLine, 200);

      expect(summary.length).toBe(203); // 200 + '...'
      expect(summary.endsWith("...")).toBe(true);
    });

    it('should return "(no output)" for empty string', () => {
      expect(extractOutputSummary("")).toBe("(no output)");
      expect(extractOutputSummary("   \n  \n   ")).toBe("(no output)");
    });

    it("should use custom maxLength", () => {
      const output = "a".repeat(100);
      const summary = extractOutputSummary(output, 50);

      expect(summary.length).toBe(53); // 50 + '...'
    });
  });

  describe("detectCompletionMarker", () => {
    it("should detect marker in output", () => {
      expect(detectCompletionMarker("Task complete RALPH_DONE", "RALPH_DONE")).toBe(true);
    });

    it("should return false when marker not present", () => {
      expect(detectCompletionMarker("Task still in progress", "RALPH_DONE")).toBe(false);
    });

    it("should detect marker anywhere in output", () => {
      expect(detectCompletionMarker("start RALPH_DONE end", "RALPH_DONE")).toBe(true);
      expect(detectCompletionMarker("RALPH_DONE", "RALPH_DONE")).toBe(true);
      expect(detectCompletionMarker("prefix\nRALPH_DONE\nsuffix", "RALPH_DONE")).toBe(true);
    });

    it("should work with custom markers", () => {
      expect(detectCompletionMarker("CUSTOM_DONE", "CUSTOM_DONE")).toBe(true);
      expect(detectCompletionMarker("<done/>", "<done/>")).toBe(true);
    });

    it("should be case-sensitive", () => {
      expect(detectCompletionMarker("ralph_done", "RALPH_DONE")).toBe(false);
    });
  });

  describe("state transitions", () => {
    it("should update status correctly", () => {
      const state = createInitialState();

      expect(state.status).toBe("running");

      state.status = "completed";
      expect(state.status).toBe("completed");

      state.status = "max_iterations_reached";
      expect(state.status).toBe("max_iterations_reached");

      state.status = "error";
      expect(state.status).toBe("error");
    });
  });

  describe("appendHistory", () => {
    it("should append history as JSON line", () => {
      const history: IterationHistory = {
        iteration: 1,
        startedAt: "2026-01-08T10:00:00Z",
        completedAt: "2026-01-08T10:01:00Z",
        durationMs: 60000,
        durationHuman: "1m 0s",
        outputSummary: "test output",
        markerFound: false,
      };

      appendHistory(history, testHistoryFile);

      const content = require("node:fs").readFileSync(testHistoryFile, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(1);

      const parsed = JSON.parse(lines[0]);
      expect(parsed.iteration).toBe(1);
      expect(parsed.outputSummary).toBe("test output");
    });

    it("should append multiple entries", () => {
      const history1: IterationHistory = {
        iteration: 1,
        startedAt: "2026-01-08T10:00:00Z",
        completedAt: "2026-01-08T10:01:00Z",
        durationMs: 60000,
        durationHuman: "1m 0s",
        outputSummary: "first",
        markerFound: false,
      };
      const history2: IterationHistory = {
        iteration: 2,
        startedAt: "2026-01-08T10:02:00Z",
        completedAt: "2026-01-08T10:03:00Z",
        durationMs: 60000,
        durationHuman: "1m 0s",
        outputSummary: "second",
        markerFound: true,
      };

      appendHistory(history1, testHistoryFile);
      appendHistory(history2, testHistoryFile);

      const content = require("node:fs").readFileSync(testHistoryFile, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(2);

      const parsed1 = JSON.parse(lines[0]);
      const parsed2 = JSON.parse(lines[1]);
      expect(parsed1.outputSummary).toBe("first");
      expect(parsed2.outputSummary).toBe("second");
      expect(parsed2.markerFound).toBe(true);
    });
  });

  describe("addPlanToState", () => {
    it("should add plan with correct structure", () => {
      const state = createInitialState();
      const plan = addPlanToState(state, "implement feature");

      expect(plan.id).toBe(1);
      expect(plan.description).toBe("implement feature");
      expect(plan.status).toBe("ready");
      expect(plan.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(plan.completedAt).toBeUndefined();
    });

    it("should increment plan IDs", () => {
      const state = createInitialState();

      const plan1 = addPlanToState(state, "plan 1");
      const plan2 = addPlanToState(state, "plan 2");
      const plan3 = addPlanToState(state, "plan 3");

      expect(plan1.id).toBe(1);
      expect(plan2.id).toBe(2);
      expect(plan3.id).toBe(3);
      expect(state.plans).toHaveLength(3);
    });

    it("should handle non-sequential IDs", () => {
      const state = createInitialState();

      // Simulate deleted plan by adding with gap
      state.plans.push({
        id: 5,
        description: "existing plan",
        status: "done",
        addedAt: new Date().toISOString(),
      });

      const newPlan = addPlanToState(state, "new plan");
      expect(newPlan.id).toBe(6);
    });
  });

  describe("formatPlansAsMarkdown", () => {
    it("should return placeholder for empty plans", () => {
      const formatted = formatPlansAsMarkdown([]);
      expect(formatted).toContain("# Plans");
      expect(formatted).toContain("No plans.");
    });

    it("should include summary counts", () => {
      const plans: RalphPlan[] = [
        { id: 1, description: "plan 1", status: "done", addedAt: "" },
        { id: 2, description: "plan 2", status: "ready", addedAt: "" },
      ];

      const formatted = formatPlansAsMarkdown(plans);

      expect(formatted).toContain("**Total:** 2");
      expect(formatted).toContain("**Done:** 1");
      expect(formatted).toContain("**Ready:** 1");
    });

    it("should format done plans with checked boxes", () => {
      const plans: RalphPlan[] = [
        { id: 1, description: "completed plan", status: "done", addedAt: "" },
      ];

      const formatted = formatPlansAsMarkdown(plans);

      expect(formatted).toContain("## Done");
      expect(formatted).toContain("- [x] **#1** completed plan");
      expect(formatted).toContain("`✓ done`");
    });

    it("should format ready plans with unchecked boxes", () => {
      const plans: RalphPlan[] = [
        { id: 2, description: "ready plan", status: "ready", addedAt: "" },
      ];

      const formatted = formatPlansAsMarkdown(plans);

      expect(formatted).toContain("## Ready");
      expect(formatted).toContain("- [ ] **#2** ready plan");
      expect(formatted).toContain("`○ ready`");
    });

    it("should group plans by status section", () => {
      const plans: RalphPlan[] = [
        { id: 1, description: "done plan", status: "done", addedAt: "" },
        { id: 2, description: "ready plan", status: "ready", addedAt: "" },
      ];

      const formatted = formatPlansAsMarkdown(plans);

      expect(formatted).toContain("## Ready");
      expect(formatted).toContain("## Done");
    });
  });

  describe("formatPlanAsMarkdown", () => {
    it("should include plan header and summary", () => {
      const state = createInitialState();
      addPlanToState(state, "plan 1");

      const formatted = formatPlanAsMarkdown(state.plans, state);

      expect(formatted).toContain("# Ralph Plan");
      expect(formatted).toContain("## Summary");
      expect(formatted).toContain("**Status:** running");
      expect(formatted).toContain("**Total:** 1");
    });

    it("should include plans section", () => {
      const state = createInitialState();
      addPlanToState(state, "implement feature");

      const formatted = formatPlanAsMarkdown(state.plans, state);

      expect(formatted).toContain("## Plans");
      expect(formatted).toContain("**#1** implement feature");
    });

    it("should include mermaid graph section", () => {
      const state = createInitialState();
      addPlanToState(state, "plan 1");
      addPlanToState(state, "plan 2");

      const formatted = formatPlanAsMarkdown(state.plans, state);

      expect(formatted).toContain("## Progress Graph");
      expect(formatted).toContain("```mermaid");
      expect(formatted).toContain("graph LR");
      expect(formatted).toContain("classDef done fill:#22c55e");
      expect(formatted).toContain("classDef ready fill:#94a3b8");
    });

    it("should format done plans correctly in mermaid", () => {
      const state = createInitialState();
      const plan = addPlanToState(state, "done plan");
      plan.status = "done";

      const formatted = formatPlanAsMarkdown(state.plans, state);

      expect(formatted).toContain('P1["#1: done plan"]:::done');
    });

    it("should truncate long descriptions in mermaid", () => {
      const state = createInitialState();
      addPlanToState(
        state,
        "This is a very long plan description that should be truncated for the mermaid graph",
      );

      const formatted = formatPlanAsMarkdown(state.plans, state);

      // Mermaid section should have truncated description
      expect(formatted).toContain('P1["#1: This is a very long plan de..."]');
      // But the Plans section should have full description
      expect(formatted).toContain(
        "**#1** This is a very long plan description that should be truncated for the mermaid graph",
      );
    });
  });

  describe("formatPlanAsJson", () => {
    it("should return valid JSON", () => {
      const state = createInitialState();
      addPlanToState(state, "plan 1");

      const json = formatPlanAsJson(state.plans, state);
      const parsed = JSON.parse(json);

      expect(parsed.status).toBe("running");
      expect(parsed.plans).toHaveLength(1);
    });

    it("should include summary counts", () => {
      const state = createInitialState();
      const plan1 = addPlanToState(state, "done plan");
      plan1.status = "done";
      addPlanToState(state, "ready plan");

      const json = formatPlanAsJson(state.plans, state);
      const parsed = JSON.parse(json);

      expect(parsed.summary.total).toBe(2);
      expect(parsed.summary.done).toBe(1);
      expect(parsed.summary.ready).toBe(1);
    });

    it("should include all plan fields", () => {
      const state = createInitialState();
      const plan = addPlanToState(state, "test plan");
      plan.status = "done";
      plan.completedAt = "2026-01-10T12:00:00Z";

      const json = formatPlanAsJson(state.plans, state);
      const parsed = JSON.parse(json);

      expect(parsed.plans[0].id).toBe(1);
      expect(parsed.plans[0].description).toBe("test plan");
      expect(parsed.plans[0].status).toBe("done");
      expect(parsed.plans[0].addedAt).toBeDefined();
      expect(parsed.plans[0].completedAt).toBe("2026-01-10T12:00:00Z");
    });
  });

  describe("markDone functionality", () => {
    it("should mark plan as done and add completedAt", () => {
      const state = createInitialState();
      addPlanToState(state, "plan 1");
      addPlanToState(state, "plan 2");

      // Simulate marking plan 1 as done
      const plan = state.plans.find((t) => t.id === 1);
      expect(plan).toBeDefined();
      expect(plan?.status).toBe("ready");

      plan!.status = "done";
      plan!.completedAt = new Date().toISOString();

      expect(plan?.status).toBe("done");
      expect(plan?.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("should find plan by ID", () => {
      const state = createInitialState();
      addPlanToState(state, "plan 1");
      addPlanToState(state, "plan 2");
      addPlanToState(state, "plan 3");

      const plan = state.plans.find((p) => p.id === 2);
      expect(plan).toBeDefined();
      expect(plan?.description).toBe("plan 2");
    });

    it("should return undefined for non-existent plan ID", () => {
      const state = createInitialState();
      addPlanToState(state, "plan 1");

      const plan = state.plans.find((t) => t.id === 99);
      expect(plan).toBeUndefined();
    });

    it("should persist marked-done plan to file", () => {
      const state = createInitialState();
      addPlanToState(state, "plan 1");

      const plan = state.plans.find((t) => t.id === 1)!;
      plan.status = "done";
      plan.completedAt = new Date().toISOString();

      saveState(state, testStateFile);
      const loaded = loadState(testStateFile);

      expect(loaded?.plans[0].status).toBe("done");
      expect(loaded?.plans[0].completedAt).toBeDefined();
    });
  });
});
