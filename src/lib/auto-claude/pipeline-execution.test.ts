import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import consola from "consola";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initConfig } from "./config";
import { ARTIFACTS } from "./prompt-templates/index";
import {
  buildTestContext,
  createSpawnClaudeMock,
  createTestRepoWithRemote,
  errorClaudeJson,
  successClaudeJson,
} from "./test-helpers";
import type { MockClaudeImpl, TestRepo } from "./test-helpers";
import type { IssueContext } from "./utils";

consola.level = -999;

let mockClaudeImpl: MockClaudeImpl = null;
vi.mock("./spawn-claude", () => createSpawnClaudeMock(() => mockClaudeImpl));

// Track gh calls for label assertions
let ghCalls: string[][] = [];

vi.mock("tinyexec", async (importOriginal) => {
  const original = await importOriginal<typeof import("tinyexec")>();
  return {
    ...original,
    x: vi.fn(
      async (
        cmd: string,
        args: string[],
        opts?: Record<string, unknown>,
      ): Promise<{ stdout: string; exitCode: number }> => {
        if (cmd === "gh") {
          ghCalls.push(args);
          // Return empty success for label/issue/pr commands
          return { stdout: "[]", exitCode: 0 };
        }
        return original.x(cmd, args, opts as never) as unknown as Promise<{
          stdout: string;
          exitCode: number;
        }>;
      },
    ),
  };
});

describe("runPipeline", () => {
  let originalCwd: string;
  let repo: TestRepo;
  let ctx: IssueContext;

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
  });

  afterEach(() => {
    process.chdir(originalCwd);
    repo.cleanup();
  });

  it("writes initial-ramblings.md on first run", async () => {
    const { runPipeline } = await import("./pipeline");

    mockClaudeImpl = () => ({ stdout: errorClaudeJson(), exitCode: 0 });

    await runPipeline(ctx);

    const ramblingsPath = join(ctx.issueDir, ARTIFACTS.initialRamblings);
    expect(existsSync(ramblingsPath)).toBe(true);

    const content = readFileSync(ramblingsPath, "utf-8");
    expect(content).toContain(ctx.title);
    expect(content).toContain(`${ctx.repo}#${ctx.number}`);
  });

  it("skips writing initial-ramblings.md if already present", async () => {
    const { runPipeline } = await import("./pipeline");

    mkdirSync(ctx.issueDir, { recursive: true });
    const ramblingsPath = join(ctx.issueDir, ARTIFACTS.initialRamblings);
    writeFileSync(ramblingsPath, "# Existing ramblings");

    mockClaudeImpl = () => ({ stdout: errorClaudeJson(), exitCode: 0 });

    await runPipeline(ctx);

    const content = readFileSync(ramblingsPath, "utf-8");
    expect(content).toBe("# Existing ramblings");
  });

  it("stops after --until step", async () => {
    const { runPipeline } = await import("./pipeline");

    let claudeCallCount = 0;
    const planPath = join(ctx.issueDir, ARTIFACTS.plan);

    mockClaudeImpl = () => {
      claudeCallCount++;
      mkdirSync(ctx.issueDir, { recursive: true });
      writeFileSync(planPath, "# Plan\n\nDetailed plan.");
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    await runPipeline(ctx, "plan");

    expect(claudeCallCount).toBe(1);
  });

  it("stops and checks out main on step failure", async () => {
    const { runPipeline } = await import("./pipeline");

    mockClaudeImpl = () => ({ stdout: errorClaudeJson(), exitCode: 0 });

    await runPipeline(ctx);

    const currentBranch = execSync("git branch --show-current", {
      cwd: repo.dir,
      encoding: "utf-8",
    }).trim();
    expect(currentBranch).toBe("main");
  });

  it("runs all 4 steps in order when review passes", async () => {
    const { runPipeline } = await import("./pipeline");

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
          writeFileSync(join(ctx.issueDir, ARTIFACTS.review), "PASS\n\nLooks good.");
          break;
      }
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    await runPipeline(ctx);

    expect(claudeCallCount).toBe(4);

    // Verify auto-claude-success and auto-claude-review labels were set
    const successLabelCall = ghCalls.find(
      (args) => args.includes("--add-label") && args.includes("auto-claude-success"),
    );
    expect(successLabelCall).toBeDefined();
    const reviewLabelCall = ghCalls.find(
      (args) => args.includes("--add-label") && args.includes("auto-claude-review"),
    );
    expect(reviewLabelCall).toBeDefined();
  });

  it("retries implement→simplify→review on review fail then pass", async () => {
    const { runPipeline } = await import("./pipeline");

    let claudeCallCount = 0;
    mockClaudeImpl = () => {
      claudeCallCount++;
      mkdirSync(ctx.issueDir, { recursive: true });

      switch (claudeCallCount) {
        case 1: // plan
          writeFileSync(join(ctx.issueDir, ARTIFACTS.plan), "# Plan");
          break;
        case 2: // implement (attempt 1)
          writeFileSync(join(ctx.issueDir, ARTIFACTS.completedSummary), "# Done");
          break;
        case 3: // simplify (attempt 1)
          writeFileSync(join(ctx.issueDir, ARTIFACTS.simplifySummary), "# Simplified");
          break;
        case 4: // review (attempt 1 - FAIL)
          writeFileSync(join(ctx.issueDir, ARTIFACTS.review), "FAIL\n\nNeeds work.");
          break;
        case 5: // implement (attempt 2)
          writeFileSync(join(ctx.issueDir, ARTIFACTS.completedSummary), "# Done v2");
          break;
        case 6: // simplify (attempt 2)
          writeFileSync(join(ctx.issueDir, ARTIFACTS.simplifySummary), "# Simplified v2");
          break;
        case 7: // review (attempt 2 - PASS)
          writeFileSync(join(ctx.issueDir, ARTIFACTS.review), "PASS\n\nGood now.");
          break;
      }
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    await runPipeline(ctx);

    // 1 plan + 3 steps * 2 attempts = 7
    expect(claudeCallCount).toBe(7);
  });

  it("sets auto-claude-failed label after max retries exhausted", async () => {
    const { runPipeline } = await import("./pipeline");

    let claudeCallCount = 0;
    mockClaudeImpl = () => {
      claudeCallCount++;
      mkdirSync(ctx.issueDir, { recursive: true });

      // Plan
      if (claudeCallCount === 1) {
        writeFileSync(join(ctx.issueDir, ARTIFACTS.plan), "# Plan");
        return { stdout: successClaudeJson(), exitCode: 0 };
      }

      // Each retry cycle: implement, simplify, review (always FAIL)
      const stepInCycle = (claudeCallCount - 2) % 3;
      switch (stepInCycle) {
        case 0:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.completedSummary), "# Done");
          break;
        case 1:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.simplifySummary), "# Simplified");
          break;
        case 2:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.review), "FAIL\n\nStill bad.");
          break;
      }
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    await runPipeline(ctx);

    // 1 plan + 3 steps * 3 attempts (maxReviewRetries=2 → 3 total) = 10
    expect(claudeCallCount).toBe(10);

    // Verify auto-claude-failed label was set
    const failedLabelCall = ghCalls.find(
      (args) => args.includes("--add-label") && args.includes("auto-claude-failed"),
    );
    expect(failedLabelCall).toBeDefined();

    // Verify issue comment was posted
    const commentCall = ghCalls.find((args) => args[0] === "issue" && args[1] === "comment");
    expect(commentCall).toBeDefined();
  });

  it("--until implement stops after implement step", async () => {
    const { runPipeline } = await import("./pipeline");

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
      }
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    await runPipeline(ctx, "implement");

    expect(claudeCallCount).toBe(2);
  });
});
