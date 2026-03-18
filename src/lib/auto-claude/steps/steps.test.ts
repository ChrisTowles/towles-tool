import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import consola from "consola";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initConfig } from "../config";
import { ARTIFACTS } from "../prompt-templates/index";
import {
  buildTestContext,
  createSpawnClaudeMock,
  createTestRepoWithRemote,
  errorClaudeJson,
  successClaudeJson,
} from "../test-helpers";
import type { MockClaudeImpl, TestRepo } from "../test-helpers";
import type { IssueContext } from "../utils";

consola.level = -999;

let mockClaudeImpl: MockClaudeImpl = null;
vi.mock("../spawn-claude", () => createSpawnClaudeMock(() => mockClaudeImpl));

// ── Shared setup/teardown for all step tests ──

function setupStepTest(): { originalCwd: string; repo: TestRepo; ctx: IssueContext } {
  const originalCwd = process.cwd();
  const repo = createTestRepoWithRemote();
  process.chdir(repo.dir);
  const ctx = buildTestContext(repo.dir);
  mkdirSync(ctx.issueDir, { recursive: true });
  mockClaudeImpl = null;
  return { originalCwd, repo, ctx };
}

function teardownStepTest(originalCwd: string, repo: TestRepo): void {
  process.chdir(originalCwd);
  repo.cleanup();
}

// ── runStepWithArtifact ──

describe("runStepWithArtifact", () => {
  let originalCwd: string;
  let repo: TestRepo;
  let ctx: IssueContext;

  beforeEach(async () => {
    ({ originalCwd, repo, ctx } = setupStepTest());
    await initConfig({ repo: "test/repo", mainBranch: "main" });
  });

  afterEach(() => teardownStepTest(originalCwd, repo));

  it("skips when artifact already exists", async () => {
    const { runStepWithArtifact } = await import("../utils");
    const artifactPath = join(ctx.issueDir, "test-artifact.md");
    writeFileSync(artifactPath, "# Existing artifact content");

    const result = await runStepWithArtifact({
      stepName: "Test Step",
      ctx,
      artifactPath,
      templateName: "01_plan.prompt.md",
    });

    expect(result).toBe(true);
  });

  it("returns false when Claude returns is_error", async () => {
    mockClaudeImpl = () => ({ stdout: errorClaudeJson(), exitCode: 0 });

    const { runStepWithArtifact } = await import("../utils");
    const artifactPath = join(ctx.issueDir, "missing-artifact.md");

    const result = await runStepWithArtifact({
      stepName: "Test Step",
      ctx,
      artifactPath,
      templateName: "01_plan.prompt.md",
    });

    expect(result).toBe(false);
  });

  it("returns false when artifact not produced after Claude run", async () => {
    mockClaudeImpl = () => ({ stdout: successClaudeJson(), exitCode: 0 });

    const { runStepWithArtifact } = await import("../utils");
    const artifactPath = join(ctx.issueDir, "never-created.md");

    const result = await runStepWithArtifact({
      stepName: "Test Step",
      ctx,
      artifactPath,
      templateName: "01_plan.prompt.md",
    });

    expect(result).toBe(false);
  });

  it("succeeds and commits when Claude produces artifact", async () => {
    const { runStepWithArtifact } = await import("../utils");
    const artifactPath = join(ctx.issueDir, "plan.md");

    mockClaudeImpl = () => {
      writeFileSync(artifactPath, "# Plan\n\nDetailed plan content here.");
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    const result = await runStepWithArtifact({
      stepName: "Test Step",
      ctx,
      artifactPath,
      templateName: "01_plan.prompt.md",
    });

    expect(result).toBe(true);
  });
});

// ── stepPlan ──

describe("stepPlan", () => {
  let originalCwd: string;
  let repo: TestRepo;
  let ctx: IssueContext;

  beforeEach(async () => {
    ({ originalCwd, repo, ctx } = setupStepTest());
    await initConfig({ repo: "test/repo", mainBranch: "main" });
  });

  afterEach(() => teardownStepTest(originalCwd, repo));

  it("skips when plan.md already exists", async () => {
    const { stepPlan } = await import("./simple-steps");

    writeFileSync(join(ctx.issueDir, ARTIFACTS.plan), "# Existing plan");

    const result = await stepPlan(ctx);
    expect(result).toBe(true);
  });

  it("calls ensureBranch and creates plan.md on success", async () => {
    const { stepPlan } = await import("./simple-steps");
    const planPath = join(ctx.issueDir, ARTIFACTS.plan);

    mockClaudeImpl = () => {
      writeFileSync(planPath, "# Plan\n\nDetailed plan.");
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    const result = await stepPlan(ctx);
    expect(result).toBe(true);

    // Verify we ended up on the branch (ensureBranch was called)
    const currentBranch = execSync("git branch --show-current", { cwd: repo.dir })
      .toString()
      .trim();
    expect(currentBranch).toBe(ctx.branch);
  });

  it("returns false when Claude fails", async () => {
    const { stepPlan } = await import("./simple-steps");

    mockClaudeImpl = () => ({ stdout: errorClaudeJson(), exitCode: 0 });

    const result = await stepPlan(ctx);
    expect(result).toBe(false);
  });
});

// ── stepSimplify ──

describe("stepSimplify", () => {
  let originalCwd: string;
  let repo: TestRepo;
  let ctx: IssueContext;

  beforeEach(async () => {
    ({ originalCwd, repo, ctx } = setupStepTest());
    await initConfig({ repo: "test/repo", mainBranch: "main" });

    // stepSimplify doesn't switch branches, but we need to be on one
    execSync(`git checkout -b ${ctx.branch}`, { cwd: repo.dir, stdio: "ignore" });
  });

  afterEach(() => teardownStepTest(originalCwd, repo));

  it("skips when simplify-summary.md already exists", async () => {
    const { stepSimplify } = await import("./simple-steps");

    writeFileSync(join(ctx.issueDir, ARTIFACTS.simplifySummary), "# Simplified");

    const result = await stepSimplify(ctx);
    expect(result).toBe(true);
  });

  it("creates simplify-summary.md on success", async () => {
    const { stepSimplify } = await import("./simple-steps");
    const artifactPath = join(ctx.issueDir, ARTIFACTS.simplifySummary);

    mockClaudeImpl = () => {
      writeFileSync(artifactPath, "# Simplify Summary\n\nCode simplified.");
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    const result = await stepSimplify(ctx);
    expect(result).toBe(true);
  });

  it("returns false when Claude fails", async () => {
    const { stepSimplify } = await import("./simple-steps");

    mockClaudeImpl = () => ({ stdout: errorClaudeJson(), exitCode: 0 });

    const result = await stepSimplify(ctx);
    expect(result).toBe(false);
  });
});

// ── stepImplement ──

describe("stepImplement", () => {
  let originalCwd: string;
  let repo: TestRepo;
  let ctx: IssueContext;

  beforeEach(async () => {
    ({ originalCwd, repo, ctx } = setupStepTest());
    await initConfig({
      repo: "test/repo",
      mainBranch: "main",
      maxImplementIterations: 3,
    });

    // stepImplement does `git checkout ctx.branch`, so create the branch
    execSync(`git checkout -b ${ctx.branch}`, { cwd: repo.dir, stdio: "ignore" });
  });

  afterEach(() => teardownStepTest(originalCwd, repo));

  it("skips when completed-summary.md exists", async () => {
    const { stepImplement } = await import("./implement");

    writeFileSync(join(ctx.issueDir, ARTIFACTS.completedSummary), "# Done");

    const result = await stepImplement(ctx);
    expect(result).toBe(true);
  });

  it("returns false after maxImplementIterations exhausted", async () => {
    const { stepImplement } = await import("./implement");

    let callCount = 0;
    mockClaudeImpl = () => {
      callCount++;
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    const result = await stepImplement(ctx);
    expect(result).toBe(false);
    expect(callCount).toBe(3);
  });

  it("passes review feedback when review.md exists", async () => {
    const { stepImplement } = await import("./implement");

    // Write a review.md to simulate review feedback
    writeFileSync(join(ctx.issueDir, ARTIFACTS.review), "# Review\n\nFix the tests.");

    const completedPath = join(ctx.issueDir, ARTIFACTS.completedSummary);
    mockClaudeImpl = () => {
      writeFileSync(completedPath, "# Done");
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    const result = await stepImplement(ctx);
    expect(result).toBe(true);
  });

  it("stops looping when completed-summary.md appears", async () => {
    const { stepImplement } = await import("./implement");

    let callCount = 0;
    const completedPath = join(ctx.issueDir, ARTIFACTS.completedSummary);

    mockClaudeImpl = () => {
      callCount++;
      if (callCount === 2) {
        writeFileSync(completedPath, "# Implementation Complete\n\nAll tasks done.");
      }
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    const result = await stepImplement(ctx);
    expect(result).toBe(true);
    expect(callCount).toBe(2);
  });
});

// ── createPr / label helpers -- skip in CI (needs gh) ──

describe.skipIf(!!process.env.CI)("createPr (requires gh)", () => {
  it.todo("skips when open PR already exists");
  it.todo("creates PR and writes pr-url.txt");
});
