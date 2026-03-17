import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Issue } from "../../utils/git/gh-cli-wrapper.js";
import { LABELS } from "../../lib/auto-claude/labels.js";
import { checkArtifacts, findAcLabel, formatIssueStatus } from "./status.js";

// ── Test fixtures ──

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    title: "Test issue",
    state: "open",
    labels: [{ name: "auto-claude", color: "000000" }],
    ...overrides,
  };
}

// ── checkArtifacts ──

describe("checkArtifacts", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ac-status-test-"));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns all false when no artifacts exist", () => {
    const result = checkArtifacts(99, tmpDir);
    expect(result).toHaveLength(4);
    for (const a of result) {
      expect(a.exists).toBe(false);
    }
  });

  it("detects existing artifacts", () => {
    const issueDir = join(tmpDir, ".auto-claude/issue-42");
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(issueDir, "plan.md"), "# Plan");
    writeFileSync(join(issueDir, "review.md"), "# Review");

    const result = checkArtifacts(42, tmpDir);
    const planArtifact = result.find((a) => a.name === "plan.md");
    const reviewArtifact = result.find((a) => a.name === "review.md");
    const summaryArtifact = result.find((a) => a.name === "completed-summary.md");

    expect(planArtifact?.exists).toBe(true);
    expect(reviewArtifact?.exists).toBe(true);
    expect(summaryArtifact?.exists).toBe(false);
  });
});

// ── findAcLabel ──

describe("findAcLabel", () => {
  it("returns specific status label when present", () => {
    const issue = makeIssue({
      labels: [
        { name: "auto-claude", color: "000000" },
        { name: LABELS.inProgress, color: "ffff00" },
      ],
    });
    expect(findAcLabel(issue)).toBe(LABELS.inProgress);
  });

  it("falls back to auto-claude when no status label", () => {
    const issue = makeIssue({
      labels: [{ name: "auto-claude", color: "000000" }],
    });
    expect(findAcLabel(issue)).toBe("auto-claude");
  });

  it("prefers in-progress over other labels", () => {
    const issue = makeIssue({
      labels: [
        { name: LABELS.inProgress, color: "ffff00" },
        { name: LABELS.success, color: "00ff00" },
      ],
    });
    expect(findAcLabel(issue)).toBe(LABELS.inProgress);
  });
});

// ── formatIssueStatus ──

describe("formatIssueStatus", () => {
  it("includes issue number and title", () => {
    const issue = makeIssue({ number: 7, title: "Fix widget" });
    const artifacts = [
      { name: "plan.md", exists: false },
      { name: "completed-summary.md", exists: false },
      { name: "simplify-summary.md", exists: false },
      { name: "review.md", exists: false },
    ];
    const output = formatIssueStatus(issue, artifacts);
    expect(output).toContain("#7");
    expect(output).toContain("Fix widget");
  });

  it("includes status tag", () => {
    const issue = makeIssue({
      labels: [{ name: LABELS.failed, color: "ff0000" }],
    });
    const artifacts = [
      { name: "plan.md", exists: false },
      { name: "completed-summary.md", exists: false },
      { name: "simplify-summary.md", exists: false },
      { name: "review.md", exists: false },
    ];
    const output = formatIssueStatus(issue, artifacts);
    expect(output).toContain("failed");
  });

  it("shows completed artifacts", () => {
    const issue = makeIssue();
    const artifacts = [
      { name: "plan.md", exists: true },
      { name: "completed-summary.md", exists: true },
      { name: "simplify-summary.md", exists: false },
      { name: "review.md", exists: false },
    ];
    const output = formatIssueStatus(issue, artifacts);
    expect(output).toContain("plan.md");
    expect(output).toContain("completed-summary.md");
    expect(output).not.toContain("simplify-summary.md");
  });

  it("omits artifacts line when none exist", () => {
    const issue = makeIssue();
    const artifacts = [
      { name: "plan.md", exists: false },
      { name: "completed-summary.md", exists: false },
      { name: "simplify-summary.md", exists: false },
      { name: "review.md", exists: false },
    ];
    const output = formatIssueStatus(issue, artifacts);
    expect(output).not.toContain("artifacts:");
  });
});
