import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import consola from "consola";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { initConfig } from "./config";
import { createTestRepo, createTestRepoWithRemote } from "./test-helpers";
import type { TestRepo } from "./test-helpers";

consola.level = -999;

// ── Shell helpers: execSafe, git ──

describe("shell helpers (real execution)", () => {
  let originalCwd: string;
  let repo: TestRepo;

  beforeAll(async () => {
    originalCwd = process.cwd();
    repo = createTestRepo();
    process.chdir(repo.dir);
    await initConfig({ repo: "test/repo", mainBranch: "main" });
  });

  afterAll(() => {
    process.chdir(originalCwd);
    repo.cleanup();
  });

  it("execSafe returns ok:true for a successful command", async () => {
    const { execSafe } = await import("./utils");
    const result = await execSafe("echo", ["hello"]);
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("hello");
  });

  it("execSafe returns ok:false for a failing command", async () => {
    const { execSafe } = await import("./utils");
    const result = await execSafe("git", ["checkout", "nonexistent-branch-xyz"]);
    expect(result.ok).toBe(false);
  });

  it("git() runs real git commands", async () => {
    const { git } = await import("./utils");
    const status = await git(["status", "--porcelain"]);
    expect(typeof status).toBe("string");
  });
});

// ── ensureBranch: real git with remote ──

describe("ensureBranch (real git)", () => {
  let originalCwd: string;
  let repo: TestRepo;

  beforeEach(async () => {
    originalCwd = process.cwd();
    repo = createTestRepoWithRemote();
    process.chdir(repo.dir);
    await initConfig({ repo: "test/repo", mainBranch: "main", remote: "origin" });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    repo.cleanup();
  });

  it("creates a new branch from main when branch doesn't exist", async () => {
    const { ensureBranch, git } = await import("./utils");

    await ensureBranch("feature/42-new-branch");

    const currentBranch = await git(["branch", "--show-current"]);
    expect(currentBranch).toBe("feature/42-new-branch");
  });

  it("checks out an existing local branch", async () => {
    const { ensureBranch, git } = await import("./utils");

    execSync("git checkout -b feature/existing-branch", { cwd: repo.dir, stdio: "ignore" });
    execSync("git checkout main", { cwd: repo.dir, stdio: "ignore" });

    await ensureBranch("feature/existing-branch");

    const currentBranch = await git(["branch", "--show-current"]);
    expect(currentBranch).toBe("feature/existing-branch");
  });

  it("can checkout after branch creation", async () => {
    const { ensureBranch, git } = await import("./utils");

    await ensureBranch("feature/99-test-checkout");
    const branch1 = await git(["branch", "--show-current"]);
    expect(branch1).toBe("feature/99-test-checkout");

    execSync("git checkout main", { cwd: repo.dir, stdio: "ignore" });
    await ensureBranch("feature/99-test-checkout");
    const branch2 = await git(["branch", "--show-current"]);
    expect(branch2).toBe("feature/99-test-checkout");
  });
});

// ── commitArtifacts: real git ──

describe("commitArtifacts (real git)", () => {
  let originalCwd: string;
  let repo: TestRepo;

  beforeEach(async () => {
    originalCwd = process.cwd();
    repo = createTestRepo();
    process.chdir(repo.dir);
    await initConfig({ repo: "test/repo", mainBranch: "main" });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    repo.cleanup();
  });

  it("commits staged files in the issue directory", async () => {
    const { commitArtifacts, buildIssueContext } = await import("./utils");

    const ctx = buildIssueContext({ number: 1, title: "Test", body: "body" }, "test/repo", ".");

    const issueDir = join(repo.dir, ctx.issueDirRel);
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(issueDir, "test.md"), "# Test artifact");

    await commitArtifacts(ctx, "test commit");

    const log = execSync("git log --oneline", { cwd: repo.dir, encoding: "utf-8" });
    expect(log).toContain("test commit");
  });

  it("does not commit when no changes are staged", async () => {
    const { commitArtifacts, buildIssueContext } = await import("./utils");

    const ctx = buildIssueContext({ number: 2, title: "Test", body: "body" }, "test/repo", ".");

    const issueDir = join(repo.dir, ctx.issueDirRel);
    mkdirSync(issueDir, { recursive: true });

    const logBefore = execSync("git log --oneline", { cwd: repo.dir, encoding: "utf-8" });
    await commitArtifacts(ctx, "should not appear");
    const logAfter = execSync("git log --oneline", { cwd: repo.dir, encoding: "utf-8" });

    expect(logAfter).toBe(logBefore);
  });
});
