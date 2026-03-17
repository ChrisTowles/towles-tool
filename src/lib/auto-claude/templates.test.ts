import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { resolveTemplate } from "./templates";
import type { TokenValues } from "./templates";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedMkdirSync = vi.mocked(mkdirSync);

describe("resolveTemplate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const tokens: TokenValues = {
    SCOPE_PATH: "/home/user/project",
    ISSUE_DIR: "/tmp/issues/42",
    MAIN_BRANCH: "main",
  };

  it("replaces all token placeholders in template", () => {
    mockedReadFileSync.mockReturnValue(
      "Scope: {{SCOPE_PATH}}\nDir: {{ISSUE_DIR}}\nBranch: {{MAIN_BRANCH}}",
    );

    resolveTemplate("plan.md", tokens, "/tmp/issues/42");

    const writtenContent = mockedWriteFileSync.mock.calls[0][1];
    expect(writtenContent).toContain("/home/user/project");
    expect(writtenContent).toContain("/tmp/issues/42");
    expect(writtenContent).toContain("main");
    expect(writtenContent).not.toContain("{{");
  });

  it("replaces REVIEW_FEEDBACK token when provided", () => {
    const tokensWithFeedback: TokenValues = {
      ...tokens,
      REVIEW_FEEDBACK: "Needs more tests",
    };
    mockedReadFileSync.mockReturnValue("Feedback: {{REVIEW_FEEDBACK}}");

    resolveTemplate("review.md", tokensWithFeedback, "/tmp/issues/42");

    const writtenContent = mockedWriteFileSync.mock.calls[0][1];
    expect(writtenContent).toContain("Needs more tests");
  });

  it("creates output directory recursively", () => {
    mockedReadFileSync.mockReturnValue("template content");

    resolveTemplate("plan.md", tokens, "/tmp/issues/42");

    expect(mockedMkdirSync).toHaveBeenCalledWith("/tmp/issues/42", { recursive: true });
  });

  it("writes resolved template to issue dir", () => {
    mockedReadFileSync.mockReturnValue("simple content");

    resolveTemplate("plan.md", tokens, "/tmp/issues/42");

    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      "/tmp/issues/42/plan.md",
      "simple content",
      "utf-8",
    );
  });

  it("returns relative path from cwd", () => {
    mockedReadFileSync.mockReturnValue("content");

    const result = resolveTemplate("plan.md", tokens, "/tmp/issues/42");
    // Should be a relative path (not starting with /)
    expect(result).not.toMatch(/^\/tmp/);
  });

  it("handles multiple occurrences of the same token", () => {
    mockedReadFileSync.mockReturnValue("{{MAIN_BRANCH}} and {{MAIN_BRANCH}} again");

    resolveTemplate("plan.md", tokens, "/tmp/issues/42");

    const writtenContent = mockedWriteFileSync.mock.calls[0][1];
    expect(writtenContent).toBe("main and main again");
  });
});
