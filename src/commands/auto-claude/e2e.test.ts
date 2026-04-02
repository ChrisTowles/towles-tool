/**
 * End-to-end tests for auto-claude pipeline.
 *
 * These tests verify the complete pipeline flow including:
 * - Full lifecycle with all 4 steps
 * - Branch creation and git operations
 * - Artifact creation and persistence
 * - Label state transitions
 * - Retry loop behavior
 * - Edge cases and failure scenarios
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import consola from "consola";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initConfig } from "./config";
import { LABELS } from "./labels";
import type { ExecSafeFn } from "./labels";
import { runPipeline } from "./pipeline";
import { ARTIFACTS } from "./prompt-templates/index";
import type { SpawnClaudeFn } from "./spawn-claude";
import {
  buildTestContext,
  createMockClaudeProcess,
  createTestRepoWithRemote,
  errorClaudeJson,
  successClaudeJson,
} from "./test-helpers";
import type { MockClaudeImpl, TestRepo } from "./test-helpers";
import type { IssueContext } from "./utils";

consola.level = -999;

describe("auto-claude e2e: full pipeline lifecycle", () => {
  let originalCwd: string;
  let repo: TestRepo;
  let ctx: IssueContext;
  let mockClaudeImpl: MockClaudeImpl;
  let ghCalls: string[][];
  let mockSpawnFn: SpawnClaudeFn;
  let mockExec: ExecSafeFn;

  beforeEach(async () => {
    originalCwd = process.cwd();
    repo = createTestRepoWithRemote();
    process.chdir(repo.dir);
    await initConfig({
      repo: "test/repo",
      mainBranch: "main",
      maxReviewRetries: 2,
    });
    ctx = buildTestContext(repo.dir);
    mockClaudeImpl = null;
    ghCalls = [];

    mockSpawnFn = vi.fn((args: string[]) => {
      if (mockClaudeImpl) {
        const { stdout, exitCode } = mockClaudeImpl(args);
        return createMockClaudeProcess(stdout, exitCode);
      }
      throw new Error("Unexpected spawnClaude call -- set mockClaudeImpl");
    }) as SpawnClaudeFn;

    mockExec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh") {
        ghCalls.push(args);
        // Return empty array for PR list checks
        if (args.includes("pr") && args.includes("list")) {
          return { stdout: "[]", ok: true };
        }
        // Return mock PR URL for PR create
        if (args.includes("pr") && args.includes("create")) {
          return { stdout: "https://github.com/test/repo/pull/1", ok: true };
        }
        return { stdout: "", ok: true };
      }
      // Pass through non-gh commands to real exec
      const { execSafe } = await import("@towles/shared");
      return execSafe(cmd, args);
    }) as ExecSafeFn;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    repo.cleanup();
  });

  it("creates feature branch and commits artifacts", async () => {
    let claudeCallCount = 0;
    mockClaudeImpl = () => {
      claudeCallCount++;
      mkdirSync(ctx.issueDir, { recursive: true });

      switch (claudeCallCount) {
        case 1:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.plan), "# Plan\n\nStep-by-step plan.");
          break;
        case 2:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.completedSummary), "# Done\n\nImpl complete.");
          break;
        case 3:
          writeFileSync(
            join(ctx.issueDir, ARTIFACTS.simplifySummary),
            "# Simplified\n\nCode simplified.",
          );
          break;
        case 4:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.review), "PASS\n\nAll checks pass.");
          break;
      }
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    await runPipeline(ctx, undefined, { spawnFn: mockSpawnFn, exec: mockExec });

    // Verify branch was created and pushed
    const branches = execSync("git branch -a", { cwd: repo.dir, encoding: "utf-8" });
    expect(branches).toContain(ctx.branch);

    // Verify all artifacts exist
    expect(existsSync(join(ctx.issueDir, ARTIFACTS.initialRamblings))).toBe(true);
    expect(existsSync(join(ctx.issueDir, ARTIFACTS.plan))).toBe(true);
    expect(existsSync(join(ctx.issueDir, ARTIFACTS.completedSummary))).toBe(true);
    expect(existsSync(join(ctx.issueDir, ARTIFACTS.simplifySummary))).toBe(true);
    expect(existsSync(join(ctx.issueDir, ARTIFACTS.review))).toBe(true);
  });

  it("preserves issue context in initial-ramblings.md", async () => {
    mockClaudeImpl = () => ({ stdout: errorClaudeJson(), exitCode: 0 });

    await runPipeline(ctx, undefined, { spawnFn: mockSpawnFn, exec: mockExec });

    const ramblingsPath = join(ctx.issueDir, ARTIFACTS.initialRamblings);
    const content = readFileSync(ramblingsPath, "utf-8");

    expect(content).toContain("# Test Issue");
    expect(content).toContain("test/repo#1");
    expect(content).toContain("Test body");
  });

  it("creates PR with correct body after successful review", async () => {
    let claudeCallCount = 0;
    mockClaudeImpl = () => {
      claudeCallCount++;
      mkdirSync(ctx.issueDir, { recursive: true });

      switch (claudeCallCount) {
        case 1:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.plan), "# Plan");
          break;
        case 2:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.completedSummary), "# Done");
          break;
        case 3:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.simplifySummary), "# Simplified");
          break;
        case 4:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.review), "PASS\n\nAll good.");
          break;
      }
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    await runPipeline(ctx, undefined, { spawnFn: mockSpawnFn, exec: mockExec });

    // Verify PR create was called
    const prCreateCall = ghCalls.find((args) => args[0] === "pr" && args[1] === "create");
    expect(prCreateCall).toBeDefined();

    // Verify PR body contains required elements
    const bodyIdx = prCreateCall!.indexOf("--body");
    const body = prCreateCall![bodyIdx + 1];
    expect(body).toContain("Closes #1");
    expect(body).toContain("Test Issue");
    expect(body).toContain(".auto-claude/issue-1/plan.md");
  });
});

describe("auto-claude e2e: label state transitions", () => {
  let originalCwd: string;
  let repo: TestRepo;
  let ctx: IssueContext;
  let mockClaudeImpl: MockClaudeImpl;
  let ghCalls: string[][];
  let mockSpawnFn: SpawnClaudeFn;
  let mockExec: ExecSafeFn;

  beforeEach(async () => {
    originalCwd = process.cwd();
    repo = createTestRepoWithRemote();
    process.chdir(repo.dir);
    await initConfig({
      repo: "test/repo",
      mainBranch: "main",
      triggerLabel: "auto-claude",
      maxReviewRetries: 1,
    });
    ctx = buildTestContext(repo.dir);
    mockClaudeImpl = null;
    ghCalls = [];

    mockSpawnFn = vi.fn((args: string[]) => {
      if (mockClaudeImpl) {
        const { stdout, exitCode } = mockClaudeImpl(args);
        return createMockClaudeProcess(stdout, exitCode);
      }
      throw new Error("Unexpected spawnClaude call");
    }) as SpawnClaudeFn;

    mockExec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh") {
        ghCalls.push(args);
        if (args.includes("pr") && args.includes("list")) {
          return { stdout: "[]", ok: true };
        }
        if (args.includes("pr") && args.includes("create")) {
          return { stdout: "https://github.com/test/repo/pull/1", ok: true };
        }
        return { stdout: "", ok: true };
      }
      const { execSafe } = await import("@towles/shared");
      return execSafe(cmd, args);
    }) as ExecSafeFn;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    repo.cleanup();
  });

  it("removes trigger label and adds in-progress at start", async () => {
    mockClaudeImpl = () => ({ stdout: errorClaudeJson(), exitCode: 0 });

    await runPipeline(ctx, undefined, { spawnFn: mockSpawnFn, exec: mockExec });

    // Verify trigger label removed
    const removeTriggerCall = ghCalls.find(
      (args) => args.includes("--remove-label") && args.includes("auto-claude"),
    );
    expect(removeTriggerCall).toBeDefined();

    // Verify in-progress label added
    const addInProgressCall = ghCalls.find(
      (args) => args.includes("--add-label") && args.includes(LABELS.inProgress),
    );
    expect(addInProgressCall).toBeDefined();
  });

  it("sets success + review labels on successful completion", async () => {
    let claudeCallCount = 0;
    mockClaudeImpl = () => {
      claudeCallCount++;
      mkdirSync(ctx.issueDir, { recursive: true });

      switch (claudeCallCount) {
        case 1:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.plan), "# Plan");
          break;
        case 2:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.completedSummary), "# Done");
          break;
        case 3:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.simplifySummary), "# Simplified");
          break;
        case 4:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.review), "PASS");
          break;
      }
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    await runPipeline(ctx, undefined, { spawnFn: mockSpawnFn, exec: mockExec });

    // Verify success label added
    const successLabelCall = ghCalls.find(
      (args) => args.includes("--add-label") && args.includes(LABELS.success),
    );
    expect(successLabelCall).toBeDefined();

    // Verify review label added
    const reviewLabelCall = ghCalls.find(
      (args) => args.includes("--add-label") && args.includes(LABELS.review),
    );
    expect(reviewLabelCall).toBeDefined();

    // Verify in-progress removed
    const removeInProgressCall = ghCalls.find(
      (args) => args.includes("--remove-label") && args.includes(LABELS.inProgress),
    );
    expect(removeInProgressCall).toBeDefined();
  });

  it("sets failed label on step failure", async () => {
    mockClaudeImpl = () => ({ stdout: errorClaudeJson(), exitCode: 0 });

    await runPipeline(ctx, undefined, { spawnFn: mockSpawnFn, exec: mockExec });

    // Verify failed label added
    const failedLabelCall = ghCalls.find(
      (args) => args.includes("--add-label") && args.includes(LABELS.failed),
    );
    expect(failedLabelCall).toBeDefined();

    // Verify in-progress removed
    const removeInProgressCall = ghCalls.find(
      (args) => args.includes("--remove-label") && args.includes(LABELS.inProgress),
    );
    expect(removeInProgressCall).toBeDefined();
  });

  it("ensures all labels exist before pipeline starts", async () => {
    mockClaudeImpl = () => ({ stdout: errorClaudeJson(), exitCode: 0 });

    await runPipeline(ctx, undefined, { spawnFn: mockSpawnFn, exec: mockExec });

    // Verify all labels were created
    const labelCreateCalls = ghCalls.filter((args) => args[0] === "label" && args[1] === "create");
    expect(labelCreateCalls.length).toBe(4);

    const createdLabels = labelCreateCalls.map((args) => args[2]);
    expect(createdLabels).toContain(LABELS.inProgress);
    expect(createdLabels).toContain(LABELS.review);
    expect(createdLabels).toContain(LABELS.failed);
    expect(createdLabels).toContain(LABELS.success);
  });
});

describe("auto-claude e2e: retry loop behavior", () => {
  let originalCwd: string;
  let repo: TestRepo;
  let ctx: IssueContext;
  let mockClaudeImpl: MockClaudeImpl;
  let ghCalls: string[][];
  let mockSpawnFn: SpawnClaudeFn;
  let mockExec: ExecSafeFn;

  beforeEach(async () => {
    originalCwd = process.cwd();
    repo = createTestRepoWithRemote();
    process.chdir(repo.dir);
    await initConfig({
      repo: "test/repo",
      mainBranch: "main",
      maxReviewRetries: 2,
    });
    ctx = buildTestContext(repo.dir);
    mockClaudeImpl = null;
    ghCalls = [];

    mockSpawnFn = vi.fn((args: string[]) => {
      if (mockClaudeImpl) {
        const { stdout, exitCode } = mockClaudeImpl(args);
        return createMockClaudeProcess(stdout, exitCode);
      }
      throw new Error("Unexpected spawnClaude call");
    }) as SpawnClaudeFn;

    mockExec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh") {
        ghCalls.push(args);
        if (args.includes("pr") && args.includes("list")) {
          return { stdout: "[]", ok: true };
        }
        if (args.includes("pr") && args.includes("create")) {
          return { stdout: "https://github.com/test/repo/pull/1", ok: true };
        }
        return { stdout: "", ok: true };
      }
      const { execSafe } = await import("@towles/shared");
      return execSafe(cmd, args);
    }) as ExecSafeFn;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    repo.cleanup();
  });

  it("clears artifacts between retry attempts", async () => {
    let claudeCallCount = 0;
    const artifactContents: Record<string, string[]> = {
      completedSummary: [],
      simplifySummary: [],
      review: [],
    };

    mockClaudeImpl = () => {
      claudeCallCount++;
      mkdirSync(ctx.issueDir, { recursive: true });

      // Plan (once)
      if (claudeCallCount === 1) {
        writeFileSync(join(ctx.issueDir, ARTIFACTS.plan), "# Plan");
        return { stdout: successClaudeJson(), exitCode: 0 };
      }

      // Each retry cycle
      const stepInCycle = (claudeCallCount - 2) % 3;
      switch (stepInCycle) {
        case 0: {
          const content = `# Done attempt ${Math.ceil((claudeCallCount - 1) / 3)}`;
          writeFileSync(join(ctx.issueDir, ARTIFACTS.completedSummary), content);
          artifactContents.completedSummary.push(content);
          break;
        }
        case 1: {
          const content = `# Simplified attempt ${Math.ceil((claudeCallCount - 1) / 3)}`;
          writeFileSync(join(ctx.issueDir, ARTIFACTS.simplifySummary), content);
          artifactContents.simplifySummary.push(content);
          break;
        }
        case 2: {
          // First two reviews FAIL, third PASS
          const attempt = Math.ceil((claudeCallCount - 1) / 3);
          const content = attempt < 3 ? "FAIL\n\nNeeds more work." : "PASS\n\nGood now.";
          writeFileSync(join(ctx.issueDir, ARTIFACTS.review), content);
          artifactContents.review.push(content);
          break;
        }
      }
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    await runPipeline(ctx, undefined, { spawnFn: mockSpawnFn, exec: mockExec });

    // Verify 3 attempts (2 retries + 1 initial)
    expect(artifactContents.completedSummary.length).toBe(3);
    expect(artifactContents.simplifySummary.length).toBe(3);
    expect(artifactContents.review.length).toBe(3);

    // Final artifacts should be from attempt 3
    const finalCompletedSummary = readFileSync(
      join(ctx.issueDir, ARTIFACTS.completedSummary),
      "utf-8",
    );
    expect(finalCompletedSummary).toContain("attempt 3");
  });

  it("posts comment with retry count on max retries exhausted", async () => {
    let claudeCallCount = 0;
    mockClaudeImpl = () => {
      claudeCallCount++;
      mkdirSync(ctx.issueDir, { recursive: true });

      if (claudeCallCount === 1) {
        writeFileSync(join(ctx.issueDir, ARTIFACTS.plan), "# Plan");
        return { stdout: successClaudeJson(), exitCode: 0 };
      }

      const stepInCycle = (claudeCallCount - 2) % 3;
      switch (stepInCycle) {
        case 0:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.completedSummary), "# Done");
          break;
        case 1:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.simplifySummary), "# Simplified");
          break;
        case 2:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.review), "FAIL\n\nStill failing.");
          break;
      }
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    await runPipeline(ctx, undefined, { spawnFn: mockSpawnFn, exec: mockExec });

    // Verify comment was posted
    const commentCall = ghCalls.find((args) => args[0] === "issue" && args[1] === "comment");
    expect(commentCall).toBeDefined();

    // Verify comment mentions retry count
    const bodyIdx = commentCall!.indexOf("--body");
    const body = commentCall![bodyIdx + 1];
    expect(body).toContain("3 attempts");
  });
});

describe("auto-claude e2e: --until flag behavior", () => {
  let originalCwd: string;
  let repo: TestRepo;
  let ctx: IssueContext;
  let mockClaudeImpl: MockClaudeImpl;
  let mockSpawnFn: SpawnClaudeFn;
  let mockExec: ExecSafeFn;
  let claudeCallCount: number;

  beforeEach(async () => {
    originalCwd = process.cwd();
    repo = createTestRepoWithRemote();
    process.chdir(repo.dir);
    await initConfig({
      repo: "test/repo",
      mainBranch: "main",
    });
    ctx = buildTestContext(repo.dir);
    mockClaudeImpl = null;
    claudeCallCount = 0;

    mockSpawnFn = vi.fn((args: string[]) => {
      if (mockClaudeImpl) {
        const { stdout, exitCode } = mockClaudeImpl(args);
        return createMockClaudeProcess(stdout, exitCode);
      }
      throw new Error("Unexpected spawnClaude call");
    }) as SpawnClaudeFn;

    mockExec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh") {
        return { stdout: "[]", ok: true };
      }
      const { execSafe } = await import("@towles/shared");
      return execSafe(cmd, args);
    }) as ExecSafeFn;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    repo.cleanup();
  });

  it("--until plan stops after plan step", async () => {
    mockClaudeImpl = () => {
      claudeCallCount++;
      mkdirSync(ctx.issueDir, { recursive: true });
      writeFileSync(join(ctx.issueDir, ARTIFACTS.plan), "# Plan");
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    await runPipeline(ctx, "plan", { spawnFn: mockSpawnFn, exec: mockExec });

    expect(claudeCallCount).toBe(1);
    expect(existsSync(join(ctx.issueDir, ARTIFACTS.plan))).toBe(true);
    expect(existsSync(join(ctx.issueDir, ARTIFACTS.completedSummary))).toBe(false);
  });

  it("--until simplify stops after simplify step", async () => {
    mockClaudeImpl = () => {
      claudeCallCount++;
      mkdirSync(ctx.issueDir, { recursive: true });

      switch (claudeCallCount) {
        case 1:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.plan), "# Plan");
          break;
        case 2:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.completedSummary), "# Done");
          break;
        case 3:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.simplifySummary), "# Simplified");
          break;
      }
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    await runPipeline(ctx, "simplify", { spawnFn: mockSpawnFn, exec: mockExec });

    expect(claudeCallCount).toBe(3);
    expect(existsSync(join(ctx.issueDir, ARTIFACTS.simplifySummary))).toBe(true);
    expect(existsSync(join(ctx.issueDir, ARTIFACTS.review))).toBe(false);
  });

  it("--until review stops before PR creation", async () => {
    mockClaudeImpl = () => {
      claudeCallCount++;
      mkdirSync(ctx.issueDir, { recursive: true });

      switch (claudeCallCount) {
        case 1:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.plan), "# Plan");
          break;
        case 2:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.completedSummary), "# Done");
          break;
        case 3:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.simplifySummary), "# Simplified");
          break;
        case 4:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.review), "PASS\n\nLooks good.");
          break;
      }
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    await runPipeline(ctx, "review", { spawnFn: mockSpawnFn, exec: mockExec });

    expect(claudeCallCount).toBe(4);
    expect(existsSync(join(ctx.issueDir, ARTIFACTS.review))).toBe(true);
    // PR should not be created with --until review
    expect(existsSync(join(ctx.issueDir, ARTIFACTS.prUrl))).toBe(false);
  });

  it("resumes from existing artifacts", async () => {
    // Pre-create plan artifact
    mkdirSync(ctx.issueDir, { recursive: true });
    writeFileSync(join(ctx.issueDir, ARTIFACTS.plan), "# Pre-existing plan");

    mockClaudeImpl = () => {
      claudeCallCount++;
      switch (claudeCallCount) {
        case 1:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.completedSummary), "# Done");
          break;
        case 2:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.simplifySummary), "# Simplified");
          break;
        case 3:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.review), "PASS");
          break;
      }
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    await runPipeline(ctx, "review", { spawnFn: mockSpawnFn, exec: mockExec });

    // Plan step should be skipped since artifact exists
    expect(claudeCallCount).toBe(3);

    // Original plan should be preserved
    const planContent = readFileSync(join(ctx.issueDir, ARTIFACTS.plan), "utf-8");
    expect(planContent).toBe("# Pre-existing plan");
  });
});

describe("auto-claude e2e: git operations", () => {
  let originalCwd: string;
  let repo: TestRepo;
  let ctx: IssueContext;
  let mockClaudeImpl: MockClaudeImpl;
  let mockSpawnFn: SpawnClaudeFn;
  let mockExec: ExecSafeFn;

  beforeEach(async () => {
    originalCwd = process.cwd();
    repo = createTestRepoWithRemote();
    process.chdir(repo.dir);
    await initConfig({
      repo: "test/repo",
      mainBranch: "main",
    });
    ctx = buildTestContext(repo.dir);
    mockClaudeImpl = null;

    mockSpawnFn = vi.fn((args: string[]) => {
      if (mockClaudeImpl) {
        const { stdout, exitCode } = mockClaudeImpl(args);
        return createMockClaudeProcess(stdout, exitCode);
      }
      throw new Error("Unexpected spawnClaude call");
    }) as SpawnClaudeFn;

    mockExec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh") {
        if (args.includes("pr") && args.includes("list")) {
          return { stdout: "[]", ok: true };
        }
        if (args.includes("pr") && args.includes("create")) {
          return { stdout: "https://github.com/test/repo/pull/1", ok: true };
        }
        return { stdout: "", ok: true };
      }
      const { execSafe } = await import("@towles/shared");
      return execSafe(cmd, args);
    }) as ExecSafeFn;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    repo.cleanup();
  });

  it("checks out main branch after pipeline completion", async () => {
    let claudeCallCount = 0;
    mockClaudeImpl = () => {
      claudeCallCount++;
      mkdirSync(ctx.issueDir, { recursive: true });

      switch (claudeCallCount) {
        case 1:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.plan), "# Plan");
          break;
        case 2:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.completedSummary), "# Done");
          break;
        case 3:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.simplifySummary), "# Simplified");
          break;
        case 4:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.review), "PASS");
          break;
      }
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    await runPipeline(ctx, undefined, { spawnFn: mockSpawnFn, exec: mockExec });

    const currentBranch = execSync("git branch --show-current", {
      cwd: repo.dir,
      encoding: "utf-8",
    }).trim();
    expect(currentBranch).toBe("main");
  });

  it("checks out main branch after failure", async () => {
    mockClaudeImpl = () => ({ stdout: errorClaudeJson(), exitCode: 0 });

    await runPipeline(ctx, undefined, { spawnFn: mockSpawnFn, exec: mockExec });

    const currentBranch = execSync("git branch --show-current", {
      cwd: repo.dir,
      encoding: "utf-8",
    }).trim();
    expect(currentBranch).toBe("main");
  });

  it("creates branch with correct naming convention", async () => {
    mockClaudeImpl = () => {
      mkdirSync(ctx.issueDir, { recursive: true });
      writeFileSync(join(ctx.issueDir, ARTIFACTS.plan), "# Plan");
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    await runPipeline(ctx, "plan", { spawnFn: mockSpawnFn, exec: mockExec });

    const branches = execSync("git branch", { cwd: repo.dir, encoding: "utf-8" });
    expect(branches).toContain("feature/1-test-issue");
  });

  it("pushes branch to remote", async () => {
    let claudeCallCount = 0;
    mockClaudeImpl = () => {
      claudeCallCount++;
      mkdirSync(ctx.issueDir, { recursive: true });

      switch (claudeCallCount) {
        case 1:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.plan), "# Plan");
          break;
        case 2:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.completedSummary), "# Done");
          break;
        case 3:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.simplifySummary), "# Simplified");
          break;
        case 4:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.review), "PASS");
          break;
      }
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    await runPipeline(ctx, undefined, { spawnFn: mockSpawnFn, exec: mockExec });

    // Verify branch exists on remote
    const remoteBranches = execSync("git branch -r", { cwd: repo.dir, encoding: "utf-8" });
    expect(remoteBranches).toContain(`origin/${ctx.branch}`);
  });
});

describe("auto-claude e2e: edge cases", () => {
  let originalCwd: string;
  let repo: TestRepo;
  let ctx: IssueContext;
  let mockClaudeImpl: MockClaudeImpl;
  let mockSpawnFn: SpawnClaudeFn;
  let mockExec: ExecSafeFn;

  beforeEach(async () => {
    originalCwd = process.cwd();
    repo = createTestRepoWithRemote();
    process.chdir(repo.dir);
    await initConfig({
      repo: "test/repo",
      mainBranch: "main",
      maxImplementIterations: 2,
    });
    ctx = buildTestContext(repo.dir);
    mockClaudeImpl = null;

    mockSpawnFn = vi.fn((args: string[]) => {
      if (mockClaudeImpl) {
        const { stdout, exitCode } = mockClaudeImpl(args);
        return createMockClaudeProcess(stdout, exitCode);
      }
      throw new Error("Unexpected spawnClaude call");
    }) as SpawnClaudeFn;

    mockExec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "gh") {
        return { stdout: "[]", ok: true };
      }
      const { execSafe } = await import("@towles/shared");
      return execSafe(cmd, args);
    }) as ExecSafeFn;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    repo.cleanup();
  });

  it("handles implement step exhausting max iterations", async () => {
    let claudeCallCount = 0;
    mockClaudeImpl = () => {
      claudeCallCount++;
      mkdirSync(ctx.issueDir, { recursive: true });

      if (claudeCallCount === 1) {
        writeFileSync(join(ctx.issueDir, ARTIFACTS.plan), "# Plan");
        return { stdout: successClaudeJson(), exitCode: 0 };
      }

      // Implement never produces artifact (max iterations exhausted)
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    await runPipeline(ctx, undefined, { spawnFn: mockSpawnFn, exec: mockExec });

    // 1 plan + 2 implement iterations = 3
    expect(claudeCallCount).toBe(3);
    expect(existsSync(join(ctx.issueDir, ARTIFACTS.completedSummary))).toBe(false);
  });

  it("handles empty issue body", async () => {
    ctx = { ...ctx, body: "" };

    mockClaudeImpl = () => ({ stdout: errorClaudeJson(), exitCode: 0 });

    await runPipeline(ctx, undefined, { spawnFn: mockSpawnFn, exec: mockExec });

    const ramblingsPath = join(ctx.issueDir, ARTIFACTS.initialRamblings);
    const content = readFileSync(ramblingsPath, "utf-8");
    expect(content).toContain("# Test Issue");
    expect(content).toContain("test/repo#1");
  });

  it("handles issue body with special characters", async () => {
    ctx = {
      ...ctx,
      body: 'Body with "quotes", <tags>, and $variables',
    };

    mockClaudeImpl = () => ({ stdout: errorClaudeJson(), exitCode: 0 });

    await runPipeline(ctx, undefined, { spawnFn: mockSpawnFn, exec: mockExec });

    const ramblingsPath = join(ctx.issueDir, ARTIFACTS.initialRamblings);
    const content = readFileSync(ramblingsPath, "utf-8");
    expect(content).toContain('"quotes"');
    expect(content).toContain("<tags>");
    expect(content).toContain("$variables");
  });

  it("handles review with lowercase pass", async () => {
    let claudeCallCount = 0;
    mockClaudeImpl = () => {
      claudeCallCount++;
      mkdirSync(ctx.issueDir, { recursive: true });

      switch (claudeCallCount) {
        case 1:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.plan), "# Plan");
          break;
        case 2:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.completedSummary), "# Done");
          break;
        case 3:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.simplifySummary), "# Simplified");
          break;
        case 4:
          // Lowercase "pass" should still be recognized
          writeFileSync(join(ctx.issueDir, ARTIFACTS.review), "pass\n\nLooks good.");
          break;
      }
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    await runPipeline(ctx, "review", { spawnFn: mockSpawnFn, exec: mockExec });

    // Should complete successfully with lowercase pass
    expect(claudeCallCount).toBe(4);
  });
});
