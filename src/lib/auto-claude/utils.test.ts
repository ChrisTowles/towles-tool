import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { initConfig } from "./config";
import { resolveTemplate } from "./templates";
import { buildContextFromArtifacts, buildIssueContext, buildTokens } from "./utils";

// Initialize config once for tests that need getConfig()
beforeAll(async () => {
  await initConfig({ repo: "test/repo", mainBranch: "main" });
});

describe("buildIssueContext", () => {
  it("should build context with correct fields", () => {
    const ctx = buildIssueContext(
      { number: 42, title: "Fix the bug", body: "Something is broken" },
      "owner/repo",
      "src/",
    );

    expect(ctx.number).toBe(42);
    expect(ctx.title).toBe("Fix the bug");
    expect(ctx.body).toBe("Something is broken");
    expect(ctx.repo).toBe("owner/repo");
    expect(ctx.scopePath).toBe("src/");
    expect(ctx.issueDirRel).toBe(".auto-claude/issue-42");
    expect(ctx.issueDir).toContain(".auto-claude/issue-42");
    expect(ctx.branch).toBe("feature/42-fix-the-bug");
  });

  it("should derive branch name from issue title", () => {
    const ctx = buildIssueContext({ number: 7, title: "t", body: "" }, "r", ".");
    expect(ctx.branch).toBe("feature/7-t");
  });
});

describe("buildTokens", () => {
  it("should produce expected token keys", () => {
    const ctx = buildIssueContext({ number: 1, title: "t", body: "" }, "test/repo", "lib/");
    const tokens = buildTokens(ctx);

    expect(tokens.SCOPE_PATH).toBe("lib/");
    expect(tokens.ISSUE_DIR).toBe(".auto-claude/issue-1");
    expect(tokens.MAIN_BRANCH).toBe("main");
  });
});

describe("resolveTemplate", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "auto-claude-test-"));
  });

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should replace token placeholders and write resolved file", () => {
    // Use an actual template from the templates dir
    const tokens = { SCOPE_PATH: "src/", ISSUE_DIR: ".auto-claude/issue-99", MAIN_BRANCH: "main" };
    const issueDir = join(tmpDir, "issue-99");
    mkdirSync(issueDir, { recursive: true });

    const result = resolveTemplate("01_plan.prompt.md", tokens, issueDir);

    // Should return a relative path
    expect(result).toContain("issue-99");
    expect(result).toContain("01_plan.prompt.md");

    // Resolved file should exist and have tokens replaced
    const content = readFileSync(join(issueDir, "01_plan.prompt.md"), "utf-8");
    expect(content).toContain("src/");
    expect(content).toContain(".auto-claude/issue-99");
    expect(content).not.toContain("{{SCOPE_PATH}}");
    expect(content).not.toContain("{{ISSUE_DIR}}");
  });
});

describe("buildContextFromArtifacts", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeAll(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "auto-claude-artifacts-"));
    process.chdir(tmpDir);
  });

  afterAll(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should throw when no artifacts exist", () => {
    expect(() => buildContextFromArtifacts(999)).toThrow("No artifacts found");
  });

  it("should parse title and body from initial-ramblings.md", async () => {
    // Re-init config in the temp dir context
    await initConfig({ repo: "test/repo", mainBranch: "main" });

    const issueDir = join(tmpDir, ".auto-claude/issue-77");
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(
      join(issueDir, "initial-ramblings.md"),
      "# My Great Feature\n\n> test/repo#77\n\nThis is the body of the issue.\nWith multiple lines.",
    );

    const ctx = buildContextFromArtifacts(77);

    expect(ctx.number).toBe(77);
    expect(ctx.title).toBe("My Great Feature");
    expect(ctx.body).toContain("This is the body of the issue.");
    expect(ctx.repo).toBe("test/repo");
    expect(ctx.branch).toBe("feature/77-my-great-feature");
  });

  it("should fallback title when heading is missing", async () => {
    await initConfig({ repo: "test/repo", mainBranch: "main" });

    const issueDir = join(tmpDir, ".auto-claude/issue-88");
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(issueDir, "initial-ramblings.md"), "No heading here\n\njust text");

    const ctx = buildContextFromArtifacts(88);
    expect(ctx.title).toBe("Issue #88");
  });
});
