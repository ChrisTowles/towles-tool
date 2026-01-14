/**
 * Unit tests for ralph-loop script
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RalphTask, IterationHistory } from "./lib/index";
import {
  createInitialState,
  saveState,
  loadState,
  addTaskToState,
  formatTasksForPrompt,
  formatTasksAsMarkdown,
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
} from "./lib/index";

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
      const state = createInitialState(5);

      expect(state.version).toBe(1);
      expect(state.iteration).toBe(0);
      expect(state.maxIterations).toBe(5);
      expect(state.status).toBe("running");
      expect(state.tasks).toEqual([]);
      expect(state.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(state.sessionId).toBeUndefined();
    });

    it("should use provided maxIterations", () => {
      const state = createInitialState(20);
      expect(state.maxIterations).toBe(20);
    });
  });

  describe("state sessionId", () => {
    it("should allow setting and persisting sessionId", () => {
      const state = createInitialState(10);
      state.sessionId = "test-session-uuid-123";

      saveState(state, testStateFile);
      const loaded = loadState(testStateFile);

      expect(loaded?.sessionId).toBe("test-session-uuid-123");
    });

    it("should preserve sessionId as undefined when not set", () => {
      const state = createInitialState(10);

      saveState(state, testStateFile);
      const loaded = loadState(testStateFile);

      expect(loaded?.sessionId).toBeUndefined();
    });
  });

  describe("saveState and loadState", () => {
    it("should save and load state correctly", () => {
      const state = createInitialState(10);
      state.iteration = 3;
      addTaskToState(state, "test task");

      saveState(state, testStateFile);
      const loaded = loadState(testStateFile);

      expect(loaded).not.toBeNull();
      expect(loaded?.iteration).toBe(3);
      expect(loaded?.tasks).toHaveLength(1);
      expect(loaded?.tasks[0].description).toBe("test task");
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
    const defaultOpts = {
      completionMarker: "RALPH_DONE",
      progressFile: "ralph-progress.md",
      focusedTaskId: null as number | null,
      taskList: JSON.stringify([{ id: 1, description: "First task", status: "ready" }], null, 2),
    };

    it("should include completion marker", () => {
      const prompt = buildIterationPrompt(defaultOpts);
      expect(prompt).toContain("RALPH_DONE");
    });

    it("should include task list as JSON", () => {
      const prompt = buildIterationPrompt(defaultOpts);
      expect(prompt).toContain('"description": "First task"');
    });

    it("should include progress file reference", () => {
      const prompt = buildIterationPrompt(defaultOpts);
      expect(prompt).toContain("@ralph-progress.md");
    });

    it("should default to choosing task when no focusedTaskId", () => {
      const prompt = buildIterationPrompt(defaultOpts);
      expect(prompt).toContain("**Choose** which ready task");
    });

    it("should focus on specific task when focusedTaskId provided", () => {
      const prompt = buildIterationPrompt({ ...defaultOpts, focusedTaskId: 3 });
      expect(prompt).toContain("**Work on Task #3**");
      expect(prompt).not.toContain("**Choose** which ready task");
    });

    it("should include custom completion marker", () => {
      const prompt = buildIterationPrompt({ ...defaultOpts, completionMarker: "CUSTOM_MARKER" });
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
    it("should track iteration progress", () => {
      const state = createInitialState(5);

      expect(state.iteration).toBe(0);

      state.iteration++;
      expect(state.iteration).toBe(1);
    });

    it("should update status correctly", () => {
      const state = createInitialState(5);

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

  describe("addTaskToState", () => {
    it("should add task with correct structure", () => {
      const state = createInitialState(10);
      const task = addTaskToState(state, "implement feature");

      expect(task.id).toBe(1);
      expect(task.description).toBe("implement feature");
      expect(task.status).toBe("ready");
      expect(task.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(task.completedAt).toBeUndefined();
    });

    it("should increment task IDs", () => {
      const state = createInitialState(10);

      const task1 = addTaskToState(state, "task 1");
      const task2 = addTaskToState(state, "task 2");
      const task3 = addTaskToState(state, "task 3");

      expect(task1.id).toBe(1);
      expect(task2.id).toBe(2);
      expect(task3.id).toBe(3);
      expect(state.tasks).toHaveLength(3);
    });

    it("should handle non-sequential IDs", () => {
      const state = createInitialState(10);

      // Simulate deleted task by adding with gap
      state.tasks.push({
        id: 5,
        description: "existing task",
        status: "done",
        addedAt: new Date().toISOString(),
      });

      const newTask = addTaskToState(state, "new task");
      expect(newTask.id).toBe(6);
    });
  });

  describe("formatTasksForPrompt", () => {
    it("should return placeholder for no tasks", () => {
      expect(formatTasksForPrompt([])).toBe("No tasks.");
    });

    it("should format tasks as markdown", () => {
      const tasks: RalphTask[] = [
        {
          id: 1,
          description: "implement feature",
          status: "ready",
          addedAt: new Date().toISOString(),
        },
      ];

      const formatted = formatTasksForPrompt(tasks);

      expect(formatted).toContain("- [ ] #1 implement feature");
      expect(formatted).toContain("`○ ready`");
    });

    it("should format multiple tasks as markdown list", () => {
      const tasks: RalphTask[] = [
        { id: 1, description: "task 1", status: "done", addedAt: "" },
        { id: 2, description: "task 2", status: "ready", addedAt: "" },
        { id: 3, description: "task 3", status: "ready", addedAt: "" },
      ];

      const formatted = formatTasksForPrompt(tasks);

      expect(formatted).toContain("- [x] #1 task 1 `✓ done`");
      expect(formatted).toContain("- [ ] #2 task 2 `○ ready`");
      expect(formatted).toContain("- [ ] #3 task 3 `○ ready`");
    });
  });

  describe("formatTasksAsMarkdown", () => {
    it("should return placeholder for empty tasks", () => {
      const formatted = formatTasksAsMarkdown([]);
      expect(formatted).toContain("# Tasks");
      expect(formatted).toContain("No tasks.");
    });

    it("should include summary counts", () => {
      const tasks: RalphTask[] = [
        { id: 1, description: "task 1", status: "done", addedAt: "" },
        { id: 2, description: "task 2", status: "ready", addedAt: "" },
      ];

      const formatted = formatTasksAsMarkdown(tasks);

      expect(formatted).toContain("**Total:** 2");
      expect(formatted).toContain("**Done:** 1");
      expect(formatted).toContain("**Ready:** 1");
    });

    it("should format done tasks with checked boxes", () => {
      const tasks: RalphTask[] = [
        { id: 1, description: "completed task", status: "done", addedAt: "" },
      ];

      const formatted = formatTasksAsMarkdown(tasks);

      expect(formatted).toContain("## Done");
      expect(formatted).toContain("- [x] **#1** completed task");
      expect(formatted).toContain("`✓ done`");
    });

    it("should format ready tasks with unchecked boxes", () => {
      const tasks: RalphTask[] = [
        { id: 2, description: "ready task", status: "ready", addedAt: "" },
      ];

      const formatted = formatTasksAsMarkdown(tasks);

      expect(formatted).toContain("## Ready");
      expect(formatted).toContain("- [ ] **#2** ready task");
      expect(formatted).toContain("`○ ready`");
    });

    it("should group tasks by status section", () => {
      const tasks: RalphTask[] = [
        { id: 1, description: "done task", status: "done", addedAt: "" },
        { id: 2, description: "ready task", status: "ready", addedAt: "" },
      ];

      const formatted = formatTasksAsMarkdown(tasks);

      expect(formatted).toContain("## Ready");
      expect(formatted).toContain("## Done");
    });
  });

  describe("loadState backwards compatibility", () => {
    it("should add empty tasks array if missing", () => {
      // Simulate old state without tasks
      const oldState = {
        version: 1,
        task: "old task", // legacy field
        startedAt: new Date().toISOString(),
        iteration: 0,
        maxIterations: 10,
        status: "running",
        history: [],
      };
      writeFileSync(testStateFile, JSON.stringify(oldState));

      const loaded = loadState(testStateFile);

      expect(loaded).not.toBeNull();
      expect(loaded?.tasks).toEqual([]);
    });
  });

  describe("formatPlanAsMarkdown", () => {
    it("should include plan header and summary", () => {
      const state = createInitialState(10);
      addTaskToState(state, "task 1");

      const formatted = formatPlanAsMarkdown(state.tasks, state);

      expect(formatted).toContain("# Ralph Plan");
      expect(formatted).toContain("## Summary");
      expect(formatted).toContain("**Status:** running");
      expect(formatted).toContain("**Total Tasks:** 1");
    });

    it("should include tasks section", () => {
      const state = createInitialState(10);
      addTaskToState(state, "implement feature");

      const formatted = formatPlanAsMarkdown(state.tasks, state);

      expect(formatted).toContain("## Tasks");
      expect(formatted).toContain("**#1** implement feature");
    });

    it("should include mermaid graph section", () => {
      const state = createInitialState(10);
      addTaskToState(state, "task 1");
      addTaskToState(state, "task 2");

      const formatted = formatPlanAsMarkdown(state.tasks, state);

      expect(formatted).toContain("## Progress Graph");
      expect(formatted).toContain("```mermaid");
      expect(formatted).toContain("graph LR");
      expect(formatted).toContain("classDef done fill:#22c55e");
      expect(formatted).toContain("classDef ready fill:#94a3b8");
    });

    it("should format done tasks correctly in mermaid", () => {
      const state = createInitialState(10);
      const task = addTaskToState(state, "done task");
      task.status = "done";

      const formatted = formatPlanAsMarkdown(state.tasks, state);

      expect(formatted).toContain('T1["#1: done task"]:::done');
    });

    it("should truncate long descriptions in mermaid", () => {
      const state = createInitialState(10);
      addTaskToState(
        state,
        "This is a very long task description that should be truncated for the mermaid graph",
      );

      const formatted = formatPlanAsMarkdown(state.tasks, state);

      // Mermaid section should have truncated description
      expect(formatted).toContain('T1["#1: This is a very long task de..."]');
      // But the Tasks section should have full description
      expect(formatted).toContain(
        "**#1** This is a very long task description that should be truncated for the mermaid graph",
      );
    });

    it("should include session ID if present", () => {
      const state = createInitialState(10);
      state.sessionId = "test-session-id-1234567890";
      addTaskToState(state, "task");

      const formatted = formatPlanAsMarkdown(state.tasks, state);

      expect(formatted).toContain("**Session ID:** test-ses...");
    });

    it("should show iteration progress", () => {
      const state = createInitialState(10);
      state.iteration = 3;
      addTaskToState(state, "task");

      const formatted = formatPlanAsMarkdown(state.tasks, state);

      expect(formatted).toContain("**Iteration:** 3/10");
    });
  });

  describe("formatPlanAsJson", () => {
    it("should return valid JSON", () => {
      const state = createInitialState(10);
      addTaskToState(state, "task 1");

      const json = formatPlanAsJson(state.tasks, state);
      const parsed = JSON.parse(json);

      expect(parsed.status).toBe("running");
      expect(parsed.tasks).toHaveLength(1);
    });

    it("should include summary counts", () => {
      const state = createInitialState(10);
      const task1 = addTaskToState(state, "done task");
      task1.status = "done";
      addTaskToState(state, "ready task");

      const json = formatPlanAsJson(state.tasks, state);
      const parsed = JSON.parse(json);

      expect(parsed.summary.total).toBe(2);
      expect(parsed.summary.done).toBe(1);
      expect(parsed.summary.ready).toBe(1);
    });

    it("should include all task fields", () => {
      const state = createInitialState(10);
      const task = addTaskToState(state, "test task");
      task.status = "done";
      task.completedAt = "2026-01-10T12:00:00Z";

      const json = formatPlanAsJson(state.tasks, state);
      const parsed = JSON.parse(json);

      expect(parsed.tasks[0].id).toBe(1);
      expect(parsed.tasks[0].description).toBe("test task");
      expect(parsed.tasks[0].status).toBe("done");
      expect(parsed.tasks[0].addedAt).toBeDefined();
      expect(parsed.tasks[0].completedAt).toBe("2026-01-10T12:00:00Z");
    });

    it("should include iteration and maxIterations", () => {
      const state = createInitialState(15);
      state.iteration = 5;
      addTaskToState(state, "task");

      const json = formatPlanAsJson(state.tasks, state);
      const parsed = JSON.parse(json);

      expect(parsed.iteration).toBe(5);
      expect(parsed.maxIterations).toBe(15);
    });

    it("should include sessionId if present", () => {
      const state = createInitialState(10);
      state.sessionId = "test-session-uuid";
      addTaskToState(state, "task");

      const json = formatPlanAsJson(state.tasks, state);
      const parsed = JSON.parse(json);

      expect(parsed.sessionId).toBe("test-session-uuid");
    });
  });

  describe("markDone functionality", () => {
    it("should mark task as done and add completedAt", () => {
      const state = createInitialState(10);
      addTaskToState(state, "task 1");
      addTaskToState(state, "task 2");

      // Simulate marking task 1 as done
      const task = state.tasks.find((t) => t.id === 1);
      expect(task).toBeDefined();
      expect(task?.status).toBe("ready");

      task!.status = "done";
      task!.completedAt = new Date().toISOString();

      expect(task?.status).toBe("done");
      expect(task?.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("should find task by ID", () => {
      const state = createInitialState(10);
      addTaskToState(state, "task 1");
      addTaskToState(state, "task 2");
      addTaskToState(state, "task 3");

      const task = state.tasks.find((t) => t.id === 2);
      expect(task).toBeDefined();
      expect(task?.description).toBe("task 2");
    });

    it("should return undefined for non-existent task ID", () => {
      const state = createInitialState(10);
      addTaskToState(state, "task 1");

      const task = state.tasks.find((t) => t.id === 99);
      expect(task).toBeUndefined();
    });

    it("should persist marked-done task to file", () => {
      const state = createInitialState(10);
      addTaskToState(state, "task 1");

      const task = state.tasks.find((t) => t.id === 1)!;
      task.status = "done";
      task.completedAt = new Date().toISOString();

      saveState(state, testStateFile);
      const loaded = loadState(testStateFile);

      expect(loaded?.tasks[0].status).toBe("done");
      expect(loaded?.tasks[0].completedAt).toBeDefined();
    });
  });
});
