import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import consola from "consola";
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { Mock } from "vitest";

import type { ExecSafeFn } from "../../lib/auto-claude/labels.js";
import { LABELS } from "../../lib/auto-claude/labels.js";
import { retryIssues } from "./retry.js";

// Suppress consola output during tests
consola.level = -999;

const mockExecSafe = vi.fn().mockResolvedValue({ stdout: "", ok: true }) as Mock & ExecSafeFn;

function getGhEditCalls() {
  return mockExecSafe.mock.calls
    .filter(
      (call: unknown[]) =>
        call[0] === "gh" && (call[1] as string[])?.[0] === "issue" && (call[1] as string[])?.[1] === "edit",
    )
    .map((call: unknown[]) => call[1] as string[]);
}

describe("retryIssues", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes failed label and adds trigger label for each issue", async () => {
    const issues = [
      {
        number: 42,
        title: "Fix bug",
        state: "OPEN",
        labels: [{ name: LABELS.failed, color: "red" }],
      },
    ];

    const count = await retryIssues("owner/repo", "auto-claude", issues, false, mockExecSafe);

    expect(count).toBe(1);
    const editCalls = getGhEditCalls();
    expect(editCalls.length).toBe(2);
    expect(editCalls[0]).toEqual(
      expect.arrayContaining(["42", "--repo", "owner/repo", "--remove-label", LABELS.failed]),
    );
    expect(editCalls[1]).toEqual(
      expect.arrayContaining(["42", "--repo", "owner/repo", "--add-label", "auto-claude"]),
    );
  });

  it("retries multiple issues", async () => {
    const issues = [
      {
        number: 10,
        title: "Issue A",
        state: "OPEN",
        labels: [{ name: LABELS.failed, color: "red" }],
      },
      {
        number: 20,
        title: "Issue B",
        state: "OPEN",
        labels: [{ name: LABELS.failed, color: "red" }],
      },
    ];

    const count = await retryIssues("owner/repo", "auto-claude", issues, false, mockExecSafe);

    expect(count).toBe(2);
    const editCalls = getGhEditCalls();
    // 2 issues * 2 label ops = 4
    expect(editCalls.length).toBe(4);
  });

  it("returns 0 when given empty selection", async () => {
    const count = await retryIssues("owner/repo", "auto-claude", [], false, mockExecSafe);
    expect(count).toBe(0);
    expect(getGhEditCalls().length).toBe(0);
  });

  it("cleans artifact directory when clean=true", async () => {
    const tmpDir = join(tmpdir(), `retry-test-${Date.now()}`);
    const issueDir = join(tmpDir, ".auto-claude", "issue-42");
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(issueDir, "test.txt"), "data");

    const originalCwd = process.cwd();
    process.chdir(tmpDir);

    try {
      const issues = [
        {
          number: 42,
          title: "Fix bug",
          state: "OPEN",
          labels: [{ name: LABELS.failed, color: "red" }],
        },
      ];

      await retryIssues("owner/repo", "auto-claude", issues, true, mockExecSafe);
      expect(existsSync(issueDir)).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("does not clean artifacts when clean=false", async () => {
    const tmpDir = join(tmpdir(), `retry-test-${Date.now()}`);
    const issueDir = join(tmpDir, ".auto-claude", "issue-42");
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(issueDir, "test.txt"), "data");

    const originalCwd = process.cwd();
    process.chdir(tmpDir);

    try {
      const issues = [
        {
          number: 42,
          title: "Fix bug",
          state: "OPEN",
          labels: [{ name: LABELS.failed, color: "red" }],
        },
      ];

      await retryIssues("owner/repo", "auto-claude", issues, false, mockExecSafe);
      expect(existsSync(issueDir)).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
