import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { ContextBundler } from "../../server/domains/execution/context-bundler";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ctx-bundler-"));
  tmpDirs.push(dir);
  return dir;
}

function makeCard(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 42,
    boardId: 1,
    title: "Fix login bug",
    description: "The login page crashes on submit",
    repoId: 1,
    column: "in_progress" as const,
    position: 0,
    executionMode: "auto-claude" as const,
    status: "running" as const,
    planId: null,
    branchMode: "create" as const,
    workflowId: null,
    githubIssueNumber: null,
    githubPrNumber: null,
    currentStepId: null,
    retryCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ContextBundler", () => {
  const bundler = new ContextBundler();

  it("replaces all template variables", () => {
    const slotPath = makeTmpDir();
    writeFileSync(
      resolve(slotPath, "plan.md"),
      "Issue #{issue} ({issue_title}): card {card_id} - {card_title}\nDesc: {card_description}",
    );

    const result = bundler.buildPrompt({
      step: { id: "plan", prompt_template: "plan.md", artifact: "plan-out.md" },
      card: makeCard(),
      slotPath,
      issueNumber: 99,
      issueTitle: "Login broken",
      previousArtifacts: new Map(),
    });

    expect(result).toBe(
      "Issue #99 (Login broken): card 42 - Fix login bug\nDesc: The login page crashes on submit",
    );
  });

  it("falls back to card description when template missing", () => {
    const slotPath = makeTmpDir();

    const result = bundler.buildPrompt({
      step: { id: "plan", prompt_template: "nonexistent.md", artifact: "out.md" },
      card: makeCard(),
      slotPath,
      previousArtifacts: new Map(),
    });

    expect(result).toBe("The login page crashes on submit");
  });

  it("falls back to card title when description is null", () => {
    const slotPath = makeTmpDir();

    const result = bundler.buildPrompt({
      step: { id: "plan", prompt_template: "nonexistent.md", artifact: "out.md" },
      card: makeCard({ description: null }),
      slotPath,
      previousArtifacts: new Map(),
    });

    expect(result).toBe("Fix login bug");
  });

  it("appends previous artifacts as context sections", () => {
    const slotPath = makeTmpDir();
    writeFileSync(resolve(slotPath, "prompt.md"), "Do the thing");

    const artifacts = new Map<string, string>();
    artifacts.set("plan", "Here is the plan output");
    artifacts.set("implement", "Here is the implementation");

    const result = bundler.buildPrompt({
      step: { id: "review", prompt_template: "prompt.md", artifact: "review.md" },
      card: makeCard(),
      slotPath,
      previousArtifacts: artifacts,
    });

    expect(result).toContain("## Output from plan step:\nHere is the plan output");
    expect(result).toContain("## Output from implement step:\nHere is the implementation");
  });

  it("appends dependency diffs", () => {
    const slotPath = makeTmpDir();
    writeFileSync(resolve(slotPath, "prompt.md"), "Build feature");

    const result = bundler.buildPrompt({
      step: { id: "implement", prompt_template: "prompt.md", artifact: "out.md" },
      card: makeCard(),
      slotPath,
      previousArtifacts: new Map(),
      dependencyDiffs: ["diff --git a/foo.ts", "diff --git a/bar.ts"],
    });

    expect(result).toContain("## Changes from dependency cards:");
    expect(result).toContain("diff --git a/foo.ts\n---\ndiff --git a/bar.ts");
  });

  it("does not append dependency section when diffs empty", () => {
    const slotPath = makeTmpDir();
    writeFileSync(resolve(slotPath, "prompt.md"), "Build feature");

    const result = bundler.buildPrompt({
      step: { id: "implement", prompt_template: "prompt.md", artifact: "out.md" },
      card: makeCard(),
      slotPath,
      previousArtifacts: new Map(),
      dependencyDiffs: [],
    });

    expect(result).not.toContain("Changes from dependency cards");
  });

  it("appends CLAUDE.md if present in slot dir", () => {
    const slotPath = makeTmpDir();
    writeFileSync(resolve(slotPath, "prompt.md"), "Do work");
    writeFileSync(resolve(slotPath, "CLAUDE.md"), "# Project rules\nUse pnpm");

    const result = bundler.buildPrompt({
      step: { id: "plan", prompt_template: "prompt.md", artifact: "out.md" },
      card: makeCard(),
      slotPath,
      previousArtifacts: new Map(),
    });

    expect(result).toContain("## Project CLAUDE.md:\n# Project rules\nUse pnpm");
  });

  it("does not append CLAUDE.md section when file missing", () => {
    const slotPath = makeTmpDir();
    writeFileSync(resolve(slotPath, "prompt.md"), "Do work");

    const result = bundler.buildPrompt({
      step: { id: "plan", prompt_template: "prompt.md", artifact: "out.md" },
      card: makeCard(),
      slotPath,
      previousArtifacts: new Map(),
    });

    expect(result).not.toContain("Project CLAUDE.md");
  });

  it("replaces missing issue vars with empty string", () => {
    const slotPath = makeTmpDir();
    writeFileSync(resolve(slotPath, "prompt.md"), "Issue: {issue} Title: {issue_title}");

    const result = bundler.buildPrompt({
      step: { id: "plan", prompt_template: "prompt.md", artifact: "out.md" },
      card: makeCard(),
      slotPath,
      previousArtifacts: new Map(),
    });

    expect(result).toBe("Issue:  Title: ");
  });
});
