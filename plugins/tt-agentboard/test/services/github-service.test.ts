import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockLogger, createMockEventBus } from "../helpers/mock-deps";
import { GitHubService } from "../../server/domains/infra/github-service";

describe("GitHubService", () => {
  let service: GitHubService;
  let mockExec: ReturnType<typeof vi.fn>;
  let mockEventBus: ReturnType<typeof createMockEventBus>;

  beforeEach(() => {
    mockExec = vi.fn();
    mockEventBus = createMockEventBus();
    service = new GitHubService({
      exec: mockExec as never,
      eventBus: mockEventBus as never,
      logger: createMockLogger() as never,
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    service.stopPolling();
  });

  describe("getOpenIssues()", () => {
    it("fetches issues via gh CLI", async () => {
      mockExec.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 1,
            title: "Bug report",
            body: "Something broken",
            labels: [{ name: "bug" }],
            url: "https://github.com/org/repo/issues/1",
          },
        ]),
        exitCode: 0,
      });

      const issues = await service.getOpenIssues("org", "repo");

      expect(issues).toHaveLength(1);
      expect(issues[0]!.number).toBe(1);
      expect(issues[0]!.title).toBe("Bug report");
      expect(issues[0]!.labels).toEqual(["bug"]);
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("issue list --repo org/repo"));
    });
  });

  describe("getIssuesWithLabel()", () => {
    it("fetches issues with the specified label", async () => {
      mockExec.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 5,
            title: "Labeled issue",
            body: "body",
            labels: [{ name: "agentboard" }],
            url: "https://github.com/org/repo/issues/5",
          },
        ]),
        exitCode: 0,
      });

      const issues = await service.getIssuesWithLabel("org", "repo", "agentboard");

      expect(issues).toHaveLength(1);
      expect(issues[0]!.labels).toEqual(["agentboard"]);
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('--label "agentboard"'));
    });
  });

  describe("createIssue()", () => {
    it("creates issue and returns data", async () => {
      mockExec.mockResolvedValueOnce({
        stdout: JSON.stringify({ number: 42, url: "https://github.com/org/repo/issues/42" }),
        exitCode: 0,
      });

      const result = await service.createIssue("org", "repo", "New issue", "body", ["bug"]);

      expect(result.number).toBe(42);
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining("issue create --repo org/repo"),
      );
    });
  });

  describe("transitionLabels()", () => {
    it("edits labels via gh issue edit", async () => {
      mockExec.mockResolvedValueOnce({ stdout: "", exitCode: 0 });

      await service.transitionLabels({
        owner: "org",
        repo: "repo",
        issueNumber: 1,
        remove: ["in-progress", "ready"],
        add: ["done"],
      });

      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("issue edit org/repo#1"));
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('--remove-label "in-progress"'),
      );
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('--add-label "done"'));
    });

    it("does nothing when no labels to add or remove", async () => {
      await service.transitionLabels({
        owner: "org",
        repo: "repo",
        issueNumber: 1,
      });

      expect(mockExec).not.toHaveBeenCalled();
    });
  });

  describe("createBranch()", () => {
    it("creates branch via gh api", async () => {
      // First call: get ref SHA
      mockExec.mockResolvedValueOnce({
        stdout: JSON.stringify({ object: { sha: "abc123" } }),
        exitCode: 0,
      });
      // Second call: create ref
      mockExec.mockResolvedValueOnce({ stdout: "", exitCode: 0 });

      const result = await service.createBranch("org", "repo", "feature/test", "main");

      expect(result.branchName).toBe("feature/test");
      expect(mockExec).toHaveBeenCalledTimes(2);
    });
  });

  describe("createPr()", () => {
    it("creates pull request", async () => {
      mockExec.mockResolvedValueOnce({
        stdout: JSON.stringify({ number: 10, url: "https://github.com/org/repo/pull/10" }),
        exitCode: 0,
      });

      const result = await service.createPr({
        owner: "org",
        repo: "repo",
        title: "PR title",
        body: "PR body",
        head: "feature/test",
        base: "main",
      });

      expect(result.number).toBe(10);
      expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("pr create --repo org/repo"));
    });
  });

  describe("startPolling()", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("polls immediately and emits events for found issues", async () => {
      mockExec.mockResolvedValue({
        stdout: JSON.stringify([
          {
            number: 1,
            title: "Issue",
            body: "",
            labels: [{ name: "agentboard" }],
            url: "https://github.com/org/repo/issues/1",
          },
        ]),
        exitCode: 0,
      });

      service.startPolling(
        [{ owner: "org", repo: "repo", repoId: 1, triggerLabel: "agentboard" }],
        60_000,
      );

      // Allow the immediate poll() to resolve
      await vi.advanceTimersByTimeAsync(0);

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        "github:issue-found",
        expect.objectContaining({ issueNumber: 1, repoId: 1 }),
      );

      service.stopPolling();
    });
  });

  describe("stopPolling()", () => {
    it("stops without error when not polling", () => {
      expect(() => service.stopPolling()).not.toThrow();
    });
  });
});
