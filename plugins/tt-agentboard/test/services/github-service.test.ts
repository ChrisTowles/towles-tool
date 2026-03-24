import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock octokit
const mockListForRepo = vi.fn();
const mockCreate = vi.fn();
const mockRemoveLabel = vi.fn();
const mockAddLabels = vi.fn();
const mockGetRef = vi.fn();
const mockCreateRef = vi.fn();
const mockPullsCreate = vi.fn();

vi.mock("octokit", () => {
  return {
    Octokit: class MockOctokit {
      rest = {
        issues: {
          listForRepo: mockListForRepo,
          create: mockCreate,
          removeLabel: mockRemoveLabel,
          addLabels: mockAddLabels,
        },
        git: {
          getRef: mockGetRef,
          createRef: mockCreateRef,
        },
        pulls: {
          create: mockPullsCreate,
        },
      };
    },
  };
});

vi.mock("../../server/utils/event-bus", () => ({
  eventBus: { emit: vi.fn(), on: vi.fn() },
}));

vi.mock("../../server/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// eslint-disable-next-line import/first -- vi.mock must come before imports (vitest hoisting)
import { GitHubService, isGitHubConfigured } from "../../server/services/github-service";
// eslint-disable-next-line import/first
import { eventBus } from "../../server/utils/event-bus";

describe("GitHubService", () => {
  let service: GitHubService;

  beforeEach(() => {
    service = new GitHubService("test-token");
    vi.clearAllMocks();
  });

  afterEach(() => {
    service.stopPolling();
  });

  describe("isGitHubConfigured()", () => {
    it("returns false when no GITHUB_TOKEN", () => {
      const original = process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_TOKEN;
      expect(isGitHubConfigured()).toBe(false);
      if (original) process.env.GITHUB_TOKEN = original;
    });

    it("returns true when GITHUB_TOKEN is set", () => {
      const original = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = "test";
      expect(isGitHubConfigured()).toBe(true);
      if (original) {
        process.env.GITHUB_TOKEN = original;
      } else {
        delete process.env.GITHUB_TOKEN;
      }
    });
  });

  describe("constructor", () => {
    it("throws when no token provided and no env var", () => {
      const original = process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_TOKEN;
      expect(() => new GitHubService()).toThrow("GITHUB_TOKEN is required");
      if (original) process.env.GITHUB_TOKEN = original;
    });
  });

  describe("getOpenIssues()", () => {
    it("fetches issues and filters out pull requests", async () => {
      mockListForRepo.mockResolvedValue({
        data: [
          {
            number: 1,
            title: "Bug report",
            body: "Something broken",
            labels: [{ name: "bug" }],
            html_url: "https://github.com/org/repo/issues/1",
          },
          {
            number: 2,
            title: "Feature PR",
            body: null,
            labels: [],
            html_url: "https://github.com/org/repo/pull/2",
            pull_request: { url: "..." },
          },
        ],
      });

      const issues = await service.getOpenIssues("org", "repo");

      expect(issues).toHaveLength(1);
      expect(issues[0]!.number).toBe(1);
      expect(issues[0]!.title).toBe("Bug report");
      expect(issues[0]!.labels).toEqual(["bug"]);
      expect(mockListForRepo).toHaveBeenCalledWith({
        owner: "org",
        repo: "repo",
        state: "open",
        per_page: 100,
      });
    });
  });

  describe("getIssuesWithLabel()", () => {
    it("fetches issues with the specified label", async () => {
      mockListForRepo.mockResolvedValue({
        data: [
          {
            number: 5,
            title: "Labeled issue",
            body: "body",
            labels: ["agentboard"],
            html_url: "https://github.com/org/repo/issues/5",
          },
        ],
      });

      const issues = await service.getIssuesWithLabel("org", "repo", "agentboard");

      expect(issues).toHaveLength(1);
      expect(issues[0]!.labels).toEqual(["agentboard"]);
      expect(mockListForRepo).toHaveBeenCalledWith({
        owner: "org",
        repo: "repo",
        labels: "agentboard",
        state: "open",
        per_page: 100,
      });
    });
  });

  describe("createIssue()", () => {
    it("creates issue and returns data", async () => {
      mockCreate.mockResolvedValue({
        data: { number: 42, title: "New issue" },
      });

      const result = await service.createIssue("org", "repo", "New issue", "body", ["bug"]);

      expect(result.number).toBe(42);
      expect(mockCreate).toHaveBeenCalledWith({
        owner: "org",
        repo: "repo",
        title: "New issue",
        body: "body",
        labels: ["bug"],
      });
    });
  });

  describe("transitionLabels()", () => {
    it("removes old labels and adds new ones", async () => {
      mockRemoveLabel.mockResolvedValue({});
      mockAddLabels.mockResolvedValue({});

      await service.transitionLabels({
        owner: "org",
        repo: "repo",
        issueNumber: 1,
        remove: ["in-progress", "ready"],
        add: ["done"],
      });

      expect(mockRemoveLabel).toHaveBeenCalledTimes(2);
      expect(mockRemoveLabel).toHaveBeenCalledWith({
        owner: "org",
        repo: "repo",
        issue_number: 1,
        name: "in-progress",
      });
      expect(mockAddLabels).toHaveBeenCalledWith({
        owner: "org",
        repo: "repo",
        issue_number: 1,
        labels: ["done"],
      });
    });

    it("ignores missing labels during removal", async () => {
      mockRemoveLabel.mockRejectedValue(new Error("Not found"));

      await service.transitionLabels({
        owner: "org",
        repo: "repo",
        issueNumber: 1,
        remove: ["nonexistent"],
      });

      // Should not throw
      expect(mockRemoveLabel).toHaveBeenCalledTimes(1);
    });

    it("does nothing when no labels to add or remove", async () => {
      await service.transitionLabels({
        owner: "org",
        repo: "repo",
        issueNumber: 1,
      });

      expect(mockRemoveLabel).not.toHaveBeenCalled();
      expect(mockAddLabels).not.toHaveBeenCalled();
    });
  });

  describe("createBranch()", () => {
    it("creates branch from base ref", async () => {
      mockGetRef.mockResolvedValue({
        data: { object: { sha: "abc123" } },
      });
      mockCreateRef.mockResolvedValue({});

      const result = await service.createBranch("org", "repo", "feature/test", "main");

      expect(result).toEqual({ branchName: "feature/test", sha: "abc123" });
      expect(mockGetRef).toHaveBeenCalledWith({
        owner: "org",
        repo: "repo",
        ref: "heads/main",
      });
      expect(mockCreateRef).toHaveBeenCalledWith({
        owner: "org",
        repo: "repo",
        ref: "refs/heads/feature/test",
        sha: "abc123",
      });
    });
  });

  describe("createPr()", () => {
    it("creates pull request", async () => {
      mockPullsCreate.mockResolvedValue({
        data: { number: 10, html_url: "https://github.com/org/repo/pull/10" },
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
      expect(mockPullsCreate).toHaveBeenCalledWith({
        owner: "org",
        repo: "repo",
        title: "PR title",
        body: "PR body",
        head: "feature/test",
        base: "main",
      });
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
      mockListForRepo.mockResolvedValue({
        data: [
          {
            number: 1,
            title: "Issue",
            body: null,
            labels: [{ name: "agentboard" }],
            html_url: "url",
          },
        ],
      });

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
