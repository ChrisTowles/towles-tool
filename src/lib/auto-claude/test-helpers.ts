import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ClaudeResult, IssueContext } from "./utils";

export interface TestRepo {
  dir: string;
  cleanup: () => void;
}

/**
 * Creates a local git repo with a single empty commit on `main`.
 */
export function createTestRepo(prefix = "ac-test-"): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email 'test@test.com'", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name 'Test'", { cwd: dir, stdio: "ignore" });
  execSync("git commit --allow-empty -m 'init'", { cwd: dir, stdio: "ignore" });
  execSync("git branch -M main", { cwd: dir, stdio: "ignore" });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Creates a local git repo backed by a bare clone acting as `origin`.
 */
export function createTestRepoWithRemote(prefix = "ac-test-remote-"): TestRepo {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const workDir = join(base, "work");
  const bareDir = join(base, "bare.git");

  mkdirSync(workDir);
  execSync("git init", { cwd: workDir, stdio: "ignore" });
  execSync("git config user.email 'test@test.com'", { cwd: workDir, stdio: "ignore" });
  execSync("git config user.name 'Test'", { cwd: workDir, stdio: "ignore" });
  execSync("git commit --allow-empty -m 'init'", { cwd: workDir, stdio: "ignore" });
  execSync("git branch -M main", { cwd: workDir, stdio: "ignore" });
  execSync(`git clone --bare "${workDir}" "${bareDir}"`, { stdio: "ignore" });
  execSync(`git remote add origin "${bareDir}"`, { cwd: workDir, stdio: "ignore" });
  execSync("git push -u origin main", { cwd: workDir, stdio: "ignore" });

  return { dir: workDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/**
 * Builds a minimal IssueContext for testing.
 */
export function buildTestContext(dir: string, issueNumber = 1): IssueContext {
  const issueDirRel = `.auto-claude/issue-${issueNumber}`;
  return {
    number: issueNumber,
    title: "Test Issue",
    body: "Test body",
    repo: "test/repo",
    scopePath: ".",
    issueDir: join(dir, issueDirRel),
    issueDirRel,
    branch: `feature/${issueNumber}-test-issue`,
  };
}

/**
 * Returns a JSON string matching a successful ClaudeResult.
 */
export function successClaudeJson(result = "done"): string {
  return JSON.stringify({
    result,
    is_error: false,
    total_cost_usd: 0.01,
    num_turns: 2,
  } satisfies ClaudeResult);
}

/**
 * Returns a JSON string matching a failed ClaudeResult.
 */
export function errorClaudeJson(result = "failed"): string {
  return JSON.stringify({
    result,
    is_error: true,
    total_cost_usd: 0,
    num_turns: 0,
  } satisfies ClaudeResult);
}
