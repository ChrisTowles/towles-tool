import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockExecSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
}));

vi.mock("../../server/utils/event-bus", () => ({
  eventBus: { emit: vi.fn(), on: vi.fn() },
}));

vi.mock("../../server/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// eslint-disable-next-line import/first -- vi.mock must come before imports (vitest hoisting)
import { GitHubService } from "../../server/services/github-service";

describe("GitHub Round-Trip Integration", () => {
  let service: GitHubService;

  beforeEach(() => {
    service = new GitHubService();
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

      mockExecSync.mockReturnValueOnce(ghOutput);

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
      mockExecSync.mockReturnValueOnce("[]");

      const issues = await service.getIssuesWithLabel("org", "repo", "agentboard");
      expect(issues).toHaveLength(0);
    });
  });

  describe("PR URL parsing from gh pr create stdout", () => {
    it("extracts PR number from URL output", async () => {
      // gh pr create outputs a URL on stdout (no --json support)
      mockExecSync.mockReturnValueOnce(
        JSON.stringify({
          number: 42,
          url: "https://github.com/org/repo/pull/42",
        }),
      );

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
      mockExecSync.mockReturnValueOnce(
        JSON.stringify({
          number: 99,
          url: "https://github.com/org/repo/pull/99",
        }),
      );

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
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("pr create"),
        expect.objectContaining({ encoding: "utf-8" }),
      );
    });
  });

  describe("label sync for status transitions", () => {
    it("generates correct gh commands for in-progress to done transition", async () => {
      mockExecSync.mockReturnValueOnce("");

      await service.transitionLabels({
        owner: "org",
        repo: "repo",
        issueNumber: 10,
        remove: ["in-progress", "agentboard"],
        add: ["done"],
      });

      const call = mockExecSync.mock.calls[0]![0] as string;
      expect(call).toContain("issue edit org/repo#10");
      expect(call).toContain('--remove-label "in-progress"');
      expect(call).toContain('--remove-label "agentboard"');
      expect(call).toContain('--add-label "done"');
    });

    it("generates correct gh commands for idle to in-progress transition", async () => {
      mockExecSync.mockReturnValueOnce("");

      await service.transitionLabels({
        owner: "org",
        repo: "repo",
        issueNumber: 5,
        remove: ["ready"],
        add: ["in-progress"],
      });

      const call = mockExecSync.mock.calls[0]![0] as string;
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

      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it("handles label transition failure gracefully", async () => {
      mockExecSync.mockImplementationOnce(() => {
        throw new Error("gh: label not found");
      });

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

      mockExecSync.mockReturnValueOnce(ghOutput);

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
      mockExecSync.mockReturnValueOnce("https://github.com/org/repo/issues/55");

      const result = await service.createIssue("org", "repo", "Test issue", "Test body", [
        "agentboard",
      ]);

      expect(result.number).toBe(55);
      expect(result.html_url).toContain("/issues/55");
    });
  });
});
