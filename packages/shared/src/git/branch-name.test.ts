import { describe, expect, it } from "vitest";
import { createBranchNameFromIssue } from "./branch-name";

describe("createBranchNameFromIssue", () => {
  it("creates branch name from issue with basic title", () => {
    const branchName = createBranchNameFromIssue({
      number: 4,
      title: "Long Issue Title - with a lot of words     and stuff ",
    });
    expect(branchName).toBe("feature/4-long-issue-title-with-a-lot-of-words-and-stuff");
  });

  it("handles special characters in title", () => {
    const branchName = createBranchNameFromIssue({
      number: 123,
      title: "Fix bug: @user reported $100 issue!",
    });
    expect(branchName).toBe("feature/123-fix-bug-user-reported-100-issue");
  });

  it("handles title with only numbers", () => {
    const branchName = createBranchNameFromIssue({ number: 42, title: "123 456" });
    expect(branchName).toBe("feature/42-123-456");
  });

  it("trims trailing dashes", () => {
    const branchName = createBranchNameFromIssue({ number: 7, title: "Update docs ---" });
    expect(branchName).toBe("feature/7-update-docs");
  });

  it("handles unicode characters", () => {
    const branchName = createBranchNameFromIssue({ number: 99, title: "Fix für Übersetzung" });
    expect(branchName).toBe("feature/99-fix-f-r-bersetzung");
  });

  it("handles empty-ish title", () => {
    const branchName = createBranchNameFromIssue({ number: 1, title: "   " });
    expect(branchName).toBe("feature/1-");
  });

  it("handles title with underscores", () => {
    const branchName = createBranchNameFromIssue({ number: 50, title: "snake_case_title" });
    expect(branchName).toBe("feature/50-snake_case_title");
  });

  it("handles very long titles", () => {
    const branchName = createBranchNameFromIssue({
      number: 200,
      title: "This is a very long issue title that goes on and on with many words",
    });
    expect(branchName).toBe(
      "feature/200-this-is-a-very-long-issue-title-that-goes-on-and-on-with-many-words",
    );
  });

  it("collapses multiple consecutive dashes", () => {
    const branchName = createBranchNameFromIssue({
      number: 15,
      title: "Fix   multiple    spaces",
    });
    expect(branchName).toBe("feature/15-fix-multiple-spaces");
  });

  it("handles title with brackets and parentheses", () => {
    const branchName = createBranchNameFromIssue({
      number: 33,
      title: "[Bug] Fix (critical) issue",
    });
    expect(branchName).toBe("feature/33--bug-fix-critical-issue");
  });

  it("produces same result whether called with minimal or extra fields", () => {
    const minimal = createBranchNameFromIssue({ number: 90, title: "Add e2e tests" });
    const withExtras = createBranchNameFromIssue({
      number: 90,
      title: "Add e2e tests",
      state: "open",
      labels: [],
    } as { number: number; title: string });
    expect(minimal).toBe(withExtras);
    expect(minimal).toBe("feature/90-add-e2e-tests");
  });
});
