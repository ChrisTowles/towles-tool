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

// ── Mock tinyexec: intercept "gh" calls, pass through git ──

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
          throw new Error("Unexpected gh call in pipeline test");
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
      maxImplementIterations: 2,
    });
    ctx = buildTestContext(repo.dir);
    mockClaudeImpl = null;
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

  it("runs all steps in order when all succeed", async () => {
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
        // case 3: simplify (placeholder — no Claude call)
        case 3:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.review), "# Review\nLooks good.");
          break;
      }
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    await runPipeline(ctx);

    expect(claudeCallCount).toBe(3);
  });
});
