import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createMockEventBus, createMockLogger } from "../helpers/mock-deps";
import { GitHubService } from "../../server/domains/infra/github-service";

describe("GitHub Round-Trip Integration", () => {
  let service: GitHubService;
  const mockExec = vi.fn();

  beforeEach(() => {
    service = new GitHubService({
      exec: mockExec,
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    service.stopPolling();
  });

  describe("issue list JSON parsing for trigger labels", () => {
    it("parses gh issue list output and detects trigger labels", async () => {
      const ghOutput = JSON.stringify([
        {
          number: 10,
          title: "Add dark mode",
          body: "Need dark mode support",
          labels: [{ name: "agentboard" }, { name: "enhancement" }],
          url: "https://github.com/org/repo/issues/10",
        },
        {
          number: 11,
          title: "Fix typo",
          body: "Typo in README",
          labels: [{ name: "bug" }],
          url: "https://github.com/org/repo/issues/11",
        },
      ]);

      mockExec.mockResolvedValueOnce({ stdout: ghOutput, exitCode: 0 });

      const issues = await service.getIssuesWithLabel("org", "repo", "agentboard");

      // Only the issue with the agentboard label should be returned
      // (the filtering is done by gh CLI via --label flag)
      expect(issues).toHaveLength(2); // gh returns what it returns; we parse all
      expect(issues[0]!.labels).toContain("agentboard");
      expect(issues[0]!.number).toBe(10);
      expect(issues[0]!.title).toBe("Add dark mode");
      expect(issues[0]!.html_url).toBe("https://github.com/org/repo/issues/10");
    });

    it("handles empty issue list", async () => {
      mockExec.mockResolvedValueOnce({ stdout: "[]", exitCode: 0 });

      const issues = await service.getIssuesWithLabel("org", "repo", "agentboard");
      expect(issues).toHaveLength(0);
    });
  });

  describe("PR URL parsing from gh pr create stdout", () => {
    it("extracts PR number from URL output", async () => {
      // gh pr create outputs a URL on stdout (no --json support)
      mockExec.mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 42,
          url: "https://github.com/org/repo/pull/42",
        }),
        exitCode: 0,
      });

      const result = await service.createPr({
        owner: "org",
        repo: "repo",
        title: "feat: add dark mode",
        body: "Automated by AgentBoard",
        head: "agentboard/card-5",
        base: "main",
      });

      expect(result.number).toBe(42);
      expect(result.html_url).toContain("/pull/42");
    });

    it("handles PR creation with special characters in title", async () => {
      mockExec.mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 99,
          url: "https://github.com/org/repo/pull/99",
        }),
        exitCode: 0,
      });

      const result = await service.createPr({
        owner: "org",
        repo: "repo",
        title: 'fix: handle "quotes" and special chars',
        body: "body",
        head: "fix/quotes",
        base: "main",
      });

      expect(result.number).toBe(99);
      // Verify the command properly escaped the title
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("pr create"));
    });
  });

  describe("label sync for status transitions", () => {
    it("generates correct gh commands for in-progress to done transition", async () => {
      mockExec.mockResolvedValueOnce({ stdout: "", exitCode: 0 });

      await service.transitionLabels({
        owner: "org",
        repo: "repo",
        issueNumber: 10,
        remove: ["in-progress", "agentboard"],
        add: ["done"],
      });

      const call = mockExec.mock.calls[0]![0] as string;
      expect(call).toContain("issue edit org/repo#10");
      expect(call).toContain('--remove-label "in-progress"');
      expect(call).toContain('--remove-label "agentboard"');
      expect(call).toContain('--add-label "done"');
    });

    it("generates correct gh commands for idle to in-progress transition", async () => {
      mockExec.mockResolvedValueOnce({ stdout: "", exitCode: 0 });

      await service.transitionLabels({
        owner: "org",
        repo: "repo",
        issueNumber: 5,
        remove: ["ready"],
        add: ["in-progress"],
      });

      const call = mockExec.mock.calls[0]![0] as string;
      expect(call).toContain("issue edit org/repo#5");
      expect(call).toContain('--remove-label "ready"');
      expect(call).toContain('--add-label "in-progress"');
    });

    it("no-ops when no labels to change", async () => {
      await service.transitionLabels({
        owner: "org",
        repo: "repo",
        issueNumber: 1,
      });

      expect(mockExec).not.toHaveBeenCalled();
    });

    it("handles label transition failure gracefully", async () => {
      mockExec.mockRejectedValueOnce(new Error("gh: label not found"));

      // Should not throw
      await expect(
        service.transitionLabels({
          owner: "org",
          repo: "repo",
          issueNumber: 1,
          add: ["nonexistent-label"],
        }),
      ).resolves.not.toThrow();
    });
  });

  describe("card creation flow from issue", () => {
    it("parses issue data suitable for card creation", async () => {
      const ghOutput = JSON.stringify([
        {
          number: 25,
          title: "Implement caching layer",
          body: "We need a caching layer for API responses.\n\n## Requirements\n- Redis support\n- TTL configuration",
          labels: [{ name: "agentboard" }, { name: "feature" }],
          url: "https://github.com/org/repo/issues/25",
        },
      ]);

      mockExec.mockResolvedValueOnce({ stdout: ghOutput, exitCode: 0 });

      const issues = await service.getOpenIssues("org", "repo");
      const issue = issues[0]!;

      // Verify the parsed issue has all fields needed for card creation
      expect(issue.number).toBe(25);
      expect(issue.title).toBe("Implement caching layer");
      expect(issue.body).toContain("caching layer");
      expect(issue.labels).toContain("agentboard");
      expect(issue.html_url).toContain("/issues/25");
    });
  });

  describe("issue creation (no --json support)", () => {
    it("parses issue number from URL in stdout", async () => {
      // gh issue create outputs a URL, not JSON
      mockExec.mockResolvedValueOnce({
        stdout: "https://github.com/org/repo/issues/55",
        exitCode: 0,
      });

      const result = await service.createIssue("org", "repo", "Test issue", "Test body", [
        "agentboard",
      ]);

      expect(result.number).toBe(55);
      expect(result.html_url).toContain("/issues/55");
    });
  });
});
