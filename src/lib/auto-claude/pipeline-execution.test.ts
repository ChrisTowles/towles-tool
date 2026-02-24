import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import consola from "consola";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initConfig } from "./config";
import { ARTIFACTS } from "./prompt-templates/index";
import {
  buildTestContext,
  createTestRepoWithRemote,
  errorClaudeJson,
  successClaudeJson,
} from "./test-helpers";
import type { TestRepo } from "./test-helpers";
import type { IssueContext } from "./utils";

consola.level = -999;

// ── Mock tinyexec: intercept "claude" and "gh" calls, pass through git ──

let mockClaudeImpl: ((args: string[]) => Promise<{ stdout: string; exitCode: number }>) | null =
  null;
let mockGhImpl: ((args: string[]) => Promise<{ stdout: string; exitCode: number }>) | null = null;

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
        if (cmd === "claude" && mockClaudeImpl) {
          return mockClaudeImpl(args);
        }
        if (cmd === "claude") {
          throw new Error("Unexpected claude call -- set mockClaudeImpl");
        }
        if (cmd === "gh" && mockGhImpl) {
          return mockGhImpl(args);
        }
        if (cmd === "gh") {
          throw new Error("Unexpected gh call -- set mockGhImpl");
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
    mockGhImpl = null;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    repo.cleanup();
  });

  it("writes initial-ramblings.md on first run", async () => {
    const { runPipeline } = await import("./pipeline");

    mockClaudeImpl = async () => ({ stdout: errorClaudeJson(), exitCode: 0 });

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

    mockClaudeImpl = async () => ({ stdout: errorClaudeJson(), exitCode: 0 });

    await runPipeline(ctx);

    const content = readFileSync(ramblingsPath, "utf-8");
    expect(content).toBe("# Existing ramblings");
  });

  it("stops after --until step", async () => {
    const { runPipeline } = await import("./pipeline");

    let claudeCallCount = 0;
    const researchPath = join(ctx.issueDir, ARTIFACTS.research);

    mockClaudeImpl = async () => {
      claudeCallCount++;
      mkdirSync(ctx.issueDir, { recursive: true });
      writeFileSync(researchPath, "x".repeat(250));
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    await runPipeline(ctx, "research");

    expect(claudeCallCount).toBe(1);
  });

  it("stops and checks out main on step failure", async () => {
    const { runPipeline } = await import("./pipeline");

    mockClaudeImpl = async () => ({ stdout: errorClaudeJson(), exitCode: 0 });

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
    mockClaudeImpl = async () => {
      claudeCallCount++;
      mkdirSync(ctx.issueDir, { recursive: true });

      switch (claudeCallCount) {
        case 1:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.research), "x".repeat(250));
          break;
        case 2:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.plan), "# Plan");
          break;
        case 3:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.planImplementation), "# Impl Plan");
          break;
        case 4:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.completedSummary), "# Done");
          break;
        case 5:
          writeFileSync(join(ctx.issueDir, ARTIFACTS.review), "# Review\nLooks good.");
          break;
      }
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    let ghCallCount = 0;
    mockGhImpl = async (args: string[]) => {
      ghCallCount++;
      if (args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]", exitCode: 0 };
      }
      if (args[0] === "pr" && args[1] === "create") {
        return { stdout: "https://github.com/test/repo/pull/1", exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    };

    await runPipeline(ctx);

    const prUrlPath = join(ctx.issueDir, ARTIFACTS.prUrl);
    if (existsSync(prUrlPath)) {
      const prUrl = readFileSync(prUrlPath, "utf-8");
      expect(prUrl).toContain("github.com");
    }

    expect(claudeCallCount).toBe(5);
    expect(ghCallCount).toBeGreaterThanOrEqual(2);
  });
});
