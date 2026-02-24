import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
      templateName: "01_research.prompt.md",
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
      templateName: "01_research.prompt.md",
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
      templateName: "01_research.prompt.md",
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
      templateName: "01_research.prompt.md",
    });

    expect(result).toBe(true);
  });
});

// ── stepResearch ──

describe("stepResearch", () => {
  let originalCwd: string;
  let repo: TestRepo;
  let ctx: IssueContext;

  beforeEach(async () => {
    ({ originalCwd, repo, ctx } = setupStepTest());
    await initConfig({ repo: "test/repo", mainBranch: "main" });
  });

  afterEach(() => teardownStepTest(originalCwd, repo));

  it("skips when research.md exists and is > 200 chars", async () => {
    const { stepResearch } = await import("./research");

    writeFileSync(join(ctx.issueDir, ARTIFACTS.research), "x".repeat(250));

    const result = await stepResearch(ctx);
    expect(result).toBe(true);
  });

  it("does NOT skip when research.md exists but is < 200 chars", async () => {
    const { stepResearch } = await import("./research");

    const researchPath = join(ctx.issueDir, ARTIFACTS.research);
    writeFileSync(researchPath, "short");

    let claudeCalled = false;
    mockClaudeImpl = () => {
      claudeCalled = true;
      writeFileSync(researchPath, "x".repeat(250));
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    const result = await stepResearch(ctx);
    expect(claudeCalled).toBe(true);
    expect(result).toBe(true);
  });

  it("calls ensureBranch (real git branch creation)", async () => {
    const { stepResearch } = await import("./research");

    const researchPath = join(ctx.issueDir, ARTIFACTS.research);
    mockClaudeImpl = () => {
      writeFileSync(researchPath, "x".repeat(250));
      return { stdout: successClaudeJson(), exitCode: 0 };
    };

    await stepResearch(ctx);

    const branches = execSync("git branch", { cwd: repo.dir, encoding: "utf-8" });
    expect(branches).toContain(ctx.branch.split("/").pop());
  });
});

// ── stepPlanAnnotations ──

describe("stepPlanAnnotations", () => {
  let originalCwd: string;
  let repo: TestRepo;
  let ctx: IssueContext;

  beforeEach(async () => {
    ({ originalCwd, repo, ctx } = setupStepTest());
    await initConfig({ repo: "test/repo", mainBranch: "main" });
  });

  afterEach(() => teardownStepTest(originalCwd, repo));

  it("returns true when no plan-annotations.md exists", async () => {
    const { stepPlanAnnotations } = await import("./plan-annotations");

    const result = await stepPlanAnnotations(ctx);
    expect(result).toBe(true);
  });

  it("skips when plan-annotations-addressed.md already exists", async () => {
    const { stepPlanAnnotations } = await import("./plan-annotations");

    writeFileSync(join(ctx.issueDir, ARTIFACTS.planAnnotations), "# Annotations");
    writeFileSync(join(ctx.issueDir, ARTIFACTS.planAnnotationsAddressed), "# Addressed");

    const result = await stepPlanAnnotations(ctx);
    expect(result).toBe(true);
  });

  it("renames file after Claude runs successfully", async () => {
    const { stepPlanAnnotations } = await import("./plan-annotations");

    const annotationsPath = join(ctx.issueDir, ARTIFACTS.planAnnotations);
    const addressedPath = join(ctx.issueDir, ARTIFACTS.planAnnotationsAddressed);
    writeFileSync(annotationsPath, "# Annotations\n\nSome feedback here.");

    mockClaudeImpl = () => ({ stdout: successClaudeJson(), exitCode: 0 });

    const result = await stepPlanAnnotations(ctx);

    expect(result).toBe(true);
    expect(existsSync(addressedPath)).toBe(true);
    expect(existsSync(annotationsPath)).toBe(false);
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

// ── stepCreatePR / stepRemoveLabel -- skip in CI (needs gh) ──

describe.skipIf(!!process.env.CI)("stepCreatePR (requires gh)", () => {
  it.todo("skips when open PR already exists");
  it.todo("creates PR and writes pr-url.txt");
});

describe.skipIf(!!process.env.CI)("stepRemoveLabel (requires gh)", () => {
  it.todo("calls gh with correct args");
});
