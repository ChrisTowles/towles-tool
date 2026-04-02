import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

import { resolveTemplate } from "./templates";
import type { TemplateFsDeps, TokenValues } from "./templates";

function createMockFs(): TemplateFsDeps & {
  readFileSync: Mock;
  writeFileSync: Mock;
  mkdirSync: Mock;
} {
  return {
    readFileSync: vi.fn().mockReturnValue(""),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
}

describe("resolveTemplate", () => {
  let mockFs: ReturnType<typeof createMockFs>;

  beforeEach(() => {
    mockFs = createMockFs();
  });

  const tokens: TokenValues = {
    SCOPE_PATH: "/home/user/project",
    ISSUE_DIR: "/tmp/issues/42",
    MAIN_BRANCH: "main",
  };

  it("replaces all token placeholders in template", () => {
    mockFs.readFileSync.mockReturnValue(
      "Scope: {{SCOPE_PATH}}\nDir: {{ISSUE_DIR}}\nBranch: {{MAIN_BRANCH}}",
    );

    resolveTemplate("plan.md", tokens, "/tmp/issues/42", mockFs);

    const writtenContent = mockFs.writeFileSync.mock.calls[0][1];
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
    mockFs.readFileSync.mockReturnValue("Feedback: {{REVIEW_FEEDBACK}}");

    resolveTemplate("review.md", tokensWithFeedback, "/tmp/issues/42", mockFs);

    const writtenContent = mockFs.writeFileSync.mock.calls[0][1];
    expect(writtenContent).toContain("Needs more tests");
  });

  it("creates output directory recursively", () => {
    mockFs.readFileSync.mockReturnValue("template content");

    resolveTemplate("plan.md", tokens, "/tmp/issues/42", mockFs);

    expect(mockFs.mkdirSync).toHaveBeenCalledWith("/tmp/issues/42", { recursive: true });
  });

  it("writes resolved template to issue dir", () => {
    mockFs.readFileSync.mockReturnValue("simple content");

    resolveTemplate("plan.md", tokens, "/tmp/issues/42", mockFs);

    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      "/tmp/issues/42/plan.md",
      "simple content",
      "utf-8",
    );
  });

  it("returns relative path from cwd", () => {
    mockFs.readFileSync.mockReturnValue("content");

    const result = resolveTemplate("plan.md", tokens, "/tmp/issues/42", mockFs);
    // Should be a relative path (not starting with /)
    expect(result).not.toMatch(/^\/tmp/);
  });

  it("handles multiple occurrences of the same token", () => {
    mockFs.readFileSync.mockReturnValue("{{MAIN_BRANCH}} and {{MAIN_BRANCH}} again");

    resolveTemplate("plan.md", tokens, "/tmp/issues/42", mockFs);

    const writtenContent = mockFs.writeFileSync.mock.calls[0][1];
    expect(writtenContent).toBe("main and main again");
  });
});
