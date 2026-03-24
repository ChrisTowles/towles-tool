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
// eslint-disable-next-line import/first
import { eventBus } from "../../server/utils/event-bus";

describe("GitHubService", () => {
  let service: GitHubService;

  beforeEach(() => {
    service = new GitHubService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    service.stopPolling();
  });

  describe("getOpenIssues()", () => {
    it("fetches issues via gh CLI", async () => {
      mockExecSync.mockReturnValueOnce(
        JSON.stringify([
          {
            number: 1,
            title: "Bug report",
            body: "Something broken",
            labels: [{ name: "bug" }],
            url: "https://github.com/org/repo/issues/1",
          },
        ]),
      );

      const issues = await service.getOpenIssues("org", "repo");

      expect(issues).toHaveLength(1);
      expect(issues[0]!.number).toBe(1);
      expect(issues[0]!.title).toBe("Bug report");
      expect(issues[0]!.labels).toEqual(["bug"]);
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("issue list --repo org/repo"),
        expect.objectContaining({ encoding: "utf-8" }),
      );
    });
  });

  describe("getIssuesWithLabel()", () => {
    it("fetches issues with the specified label", async () => {
      mockExecSync.mockReturnValueOnce(
        JSON.stringify([
          {
            number: 5,
            title: "Labeled issue",
            body: "body",
            labels: [{ name: "agentboard" }],
            url: "https://github.com/org/repo/issues/5",
          },
        ]),
      );

      const issues = await service.getIssuesWithLabel("org", "repo", "agentboard");

      expect(issues).toHaveLength(1);
      expect(issues[0]!.labels).toEqual(["agentboard"]);
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('--label "agentboard"'),
        expect.objectContaining({ encoding: "utf-8" }),
      );
    });
  });

  describe("createIssue()", () => {
    it("creates issue and returns data", async () => {
      mockExecSync.mockReturnValueOnce(
        JSON.stringify({ number: 42, url: "https://github.com/org/repo/issues/42" }),
      );

      const result = await service.createIssue("org", "repo", "New issue", "body", ["bug"]);

      expect(result.number).toBe(42);
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("issue create --repo org/repo"),
        expect.objectContaining({ encoding: "utf-8" }),
      );
    });
  });

  describe("transitionLabels()", () => {
    it("edits labels via gh issue edit", async () => {
      mockExecSync.mockReturnValueOnce("");

      await service.transitionLabels({
        owner: "org",
        repo: "repo",
        issueNumber: 1,
        remove: ["in-progress", "ready"],
        add: ["done"],
      });

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("issue edit org/repo#1"),
        expect.objectContaining({ encoding: "utf-8" }),
      );
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('--remove-label "in-progress"'),
        expect.objectContaining({ encoding: "utf-8" }),
      );
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('--add-label "done"'),
        expect.objectContaining({ encoding: "utf-8" }),
      );
    });

    it("does nothing when no labels to add or remove", async () => {
      await service.transitionLabels({
        owner: "org",
        repo: "repo",
        issueNumber: 1,
      });

      expect(mockExecSync).not.toHaveBeenCalled();
    });
  });

  describe("createBranch()", () => {
    it("creates branch via gh api", async () => {
      // First call: get ref SHA
      mockExecSync.mockReturnValueOnce(JSON.stringify({ object: { sha: "abc123" } }));
      // Second call: create ref
      mockExecSync.mockReturnValueOnce("");

      const result = await service.createBranch("org", "repo", "feature/test", "main");

      expect(result.branchName).toBe("feature/test");
      expect(mockExecSync).toHaveBeenCalledTimes(2);
    });
  });

  describe("createPr()", () => {
    it("creates pull request", async () => {
      mockExecSync.mockReturnValueOnce(
        JSON.stringify({ number: 10, url: "https://github.com/org/repo/pull/10" }),
      );

      const result = await service.createPr({
        owner: "org",
        repo: "repo",
        title: "PR title",
        body: "PR body",
        head: "feature/test",
        base: "main",
      });

      expect(result.number).toBe(10);
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("pr create --repo org/repo"),
        expect.objectContaining({ encoding: "utf-8" }),
      );
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
      mockExecSync.mockReturnValue(
        JSON.stringify([
          {
            number: 1,
            title: "Issue",
            body: "",
            labels: [{ name: "agentboard" }],
            url: "https://github.com/org/repo/issues/1",
          },
        ]),
      );

      service.startPolling(
        [{ owner: "org", repo: "repo", repoId: 1, triggerLabel: "agentboard" }],
        60_000,
      );

      // Allow the immediate poll() to resolve
      await vi.advanceTimersByTimeAsync(0);

      expect(vi.mocked(eventBus.emit)).toHaveBeenCalledWith(
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
