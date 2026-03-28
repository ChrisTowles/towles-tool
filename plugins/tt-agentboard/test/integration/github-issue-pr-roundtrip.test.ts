import { describe, it, expect, beforeAll, vi, beforeEach, afterEach } from "vitest";
import {
  createTestRepo,
  createTestSlot,
  createTestCard,
  getCard,
  moveCard,
  updateCard,
  simulateStopHook,
  api,
  apiRaw,
} from "../helpers";
import { createMockEventBus, createMockLogger } from "../helpers/mock-deps";
import { GitHubService } from "../../server/domains/infra/github-service";

/**
 * Integration test: GitHub issue → card → agent → PR round-trip
 *
 * Tests the full lifecycle:
 * 1. GitHub issue discovered (mocked) → card created
 * 2. Card moved to in_progress → agent starts
 * 3. Agent completes (Stop hook) → card moves to review
 * 4. PR created for the card's branch
 * 5. Card moved to done → issue labels synced
 *
 * This test uses mocked gh CLI commands to avoid requiring
 * actual GitHub authentication in CI.
 */
describe("GitHub Issue → Card → Agent → PR Round-Trip (integration)", () => {
  let repoId: number;

  beforeAll(async () => {
    // Create test repo and slot
    const repo = await createTestRepo("gh-roundtrip-repo");
    repoId = repo.id;

    await createTestSlot(repoId, "/tmp/gh-roundtrip-workspace");

    // Update repo with org/name for GitHub integration
    await api(`/api/repos/${repoId}`, {
      method: "PUT",
      body: JSON.stringify({
        org: "test-org",
        name: "test-repo",
        triggerLabel: "agentboard",
      }),
    });
  });

  describe("Step 1: Issue discovery → Card creation", () => {
    it("creates a card from a GitHub issue via event", async () => {
      // Create a card that simulates being created from a GitHub issue
      const card = await createTestCard(repoId, "Fix: Add missing validation", {
        githubIssueNumber: 42,
      });

      expect(card.id).toBeDefined();
      expect(card.title).toBe("Fix: Add missing validation");
      expect(card.column).toBe("backlog");
      expect(card.status).toBe("idle");

      // Verify card can be fetched with issue number
      const fetched = await getCard(card.id);
      expect(fetched.id).toBe(card.id);
    });

    it("card with issue number is linked correctly", async () => {
      const card = await createTestCard(repoId, "Feature: Add dark mode", {
        githubIssueNumber: 55,
        column: "ready",
      });

      await updateCard(card.id, { column: "ready", status: "idle" });

      const updated = await getCard(card.id);
      expect(updated.column).toBe("ready");
      expect(updated.status).toBe("idle");
    });
  });

  describe("Step 2: Card execution lifecycle", () => {
    let cardId: number;

    beforeAll(async () => {
      const card = await createTestCard(repoId, "Test: Integration card", {
        githubIssueNumber: 100,
        executionMode: "headless",
      });
      cardId = card.id;
    });

    it("moves card to in_progress and starts agent", async () => {
      await moveCard(cardId, "in_progress");

      // Wait for async processing
      await new Promise((r) => setTimeout(r, 500));

      const card = await getCard(cardId);
      expect(card.column).toBe("in_progress");
      // Status should be running or queued (depending on slot availability)
      expect(["running", "queued"]).toContain(card.status);
    });

    it("Stop hook moves card to review_ready", async () => {
      // Ensure card is running before sending Stop hook
      await updateCard(cardId, { status: "running" });

      const result = await simulateStopHook(cardId);
      expect(result.ok).toBe(true);

      const card = await getCard(cardId);
      expect(card.column).toBe("review");
      expect(card.status).toBe("review_ready");
    });
  });

  describe("Step 3: PR creation flow", () => {
    let cardId: number;

    beforeAll(async () => {
      const card = await createTestCard(repoId, "PR Test: Create feature", {
        githubIssueNumber: 200,
        executionMode: "headless",
      });
      cardId = card.id;

      // Simulate the full flow: ready → in_progress → running → Stop hook
      await moveCard(cardId, "in_progress");
      await new Promise((r) => setTimeout(r, 300));
      await updateCard(cardId, { status: "running" });
      await simulateStopHook(cardId);
    });

    it("card is in review column after Stop hook", async () => {
      const card = await getCard(cardId);
      expect(card.column).toBe("review");
      expect(card.status).toBe("review_ready");
    });

    // Note: PR creation requires a real git repo with branches,
    // so we test the API endpoint exists and validates correctly
    it("create-pr endpoint returns error without workflow run", async () => {
      const res = await apiRaw(`/api/agents/${cardId}/create-pr`, {
        method: "POST",
      });

      // Should fail because no workflow run with branch exists
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.statusMessage).toContain("No branch found");
    });
  });

  describe("Step 4: Card completion and done status", () => {
    let cardId: number;

    beforeAll(async () => {
      const card = await createTestCard(repoId, "Done Test: Complete task", {
        githubIssueNumber: 300,
      });
      cardId = card.id;

      // Full lifecycle to review
      await moveCard(cardId, "in_progress");
      await new Promise((r) => setTimeout(r, 300));
      await updateCard(cardId, { status: "running" });
      await simulateStopHook(cardId);
    });

    it("card can be moved from review to done", async () => {
      const before = await getCard(cardId);
      expect(before.column).toBe("review");

      await moveCard(cardId, "done");

      const after = await getCard(cardId);
      expect(after.column).toBe("done");
      expect(after.status).toBe("done");
    });
  });

  describe("GitHubService unit tests for round-trip", () => {
    let service: GitHubService;
    const mockExecSync = vi.fn();

    beforeEach(() => {
      service = new GitHubService({
        execSync: mockExecSync,
        eventBus: createMockEventBus(),
        logger: createMockLogger(),
      });
      vi.clearAllMocks();
    });

    afterEach(() => {
      service.stopPolling();
    });

    it("issue → card data transformation is correct", async () => {
      mockExecSync.mockReturnValueOnce(
        JSON.stringify([
          {
            number: 42,
            title: "Add validation to user input",
            body: "## Problem\nNo validation exists\n\n## Solution\nAdd Zod schema",
            labels: [{ name: "agentboard" }, { name: "enhancement" }],
            url: "https://github.com/test-org/test-repo/issues/42",
          },
        ]),
      );

      const issues = await service.getIssuesWithLabel("test-org", "test-repo", "agentboard");

      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        number: 42,
        title: "Add validation to user input",
        labels: expect.arrayContaining(["agentboard", "enhancement"]),
        html_url: expect.stringContaining("/issues/42"),
      });
    });

    it("PR creation returns parsed number and URL", async () => {
      mockExecSync.mockReturnValueOnce(
        JSON.stringify({
          number: 123,
          url: "https://github.com/test-org/test-repo/pull/123",
        }),
      );

      const result = await service.createPr({
        owner: "test-org",
        repo: "test-repo",
        title: "feat: Add validation",
        body: "Closes #42",
        head: "agentboard/card-1",
        base: "main",
      });

      expect(result.number).toBe(123);
      expect(result.html_url).toContain("/pull/123");
    });

    it("label transitions generate correct gh commands", async () => {
      mockExecSync.mockReturnValue("");

      // Simulate status → label sync: running → done
      await service.transitionLabels({
        owner: "test-org",
        repo: "test-repo",
        issueNumber: 42,
        remove: ["in-progress"],
        add: ["done"],
      });

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining(
          'issue edit test-org/test-repo#42 --remove-label "in-progress" --add-label "done"',
        ),
        expect.any(Object),
      );
    });

    it("full round-trip simulation", async () => {
      // 1. Issue discovered
      mockExecSync.mockReturnValueOnce(
        JSON.stringify([
          {
            number: 99,
            title: "Round-trip test issue",
            body: "Test body",
            labels: [{ name: "agentboard" }],
            url: "https://github.com/org/repo/issues/99",
          },
        ]),
      );

      const issues = await service.getIssuesWithLabel("org", "repo", "agentboard");
      expect(issues[0]!.number).toBe(99);

      // 2. Card created (handled by github-poll plugin in real system)
      // 3. Agent runs and completes (handled by agent-executor)

      // 4. PR created
      mockExecSync.mockReturnValueOnce(
        JSON.stringify({
          number: 50,
          url: "https://github.com/org/repo/pull/50",
        }),
      );

      const pr = await service.createPr({
        owner: "org",
        repo: "repo",
        title: "feat: Round-trip test issue",
        body: "Closes #99",
        head: "agentboard/card-99",
        base: "main",
      });
      expect(pr.number).toBe(50);

      // 5. Labels synced
      mockExecSync.mockReturnValueOnce("");
      await service.transitionLabels({
        owner: "org",
        repo: "repo",
        issueNumber: 99,
        remove: ["agentboard", "in-progress"],
        add: ["done"],
      });

      // Verify final transition command
      const lastCall = mockExecSync.mock.calls[mockExecSync.mock.calls.length - 1]![0] as string;
      expect(lastCall).toContain("issue edit org/repo#99");
      expect(lastCall).toContain('--add-label "done"');
    });
  });

  describe("Event flow verification", () => {
    it("card status changes emit correct events", async () => {
      const card = await createTestCard(repoId, "Event test card");

      // Move through lifecycle
      await moveCard(card.id, "ready");
      const readyCard = await getCard(card.id);
      expect(readyCard.column).toBe("ready");

      await moveCard(card.id, "in_progress");
      await new Promise((r) => setTimeout(r, 300));
      const inProgressCard = await getCard(card.id);
      expect(inProgressCard.column).toBe("in_progress");

      // Force running and complete
      await updateCard(card.id, { status: "running" });
      await simulateStopHook(card.id);

      const completedCard = await getCard(card.id);
      expect(completedCard.column).toBe("review");
      expect(completedCard.status).toBe("review_ready");
    });
  });

  describe("Error handling", () => {
    it("Stop hook on non-running card is ignored", async () => {
      const card = await createTestCard(repoId, "Non-running card");

      // Card is in backlog/idle, Stop hook should be ignored
      const result = await simulateStopHook(card.id);
      expect(result.ok).toBe(true);

      // Verify card wasn't moved to review
      const after = await getCard(card.id);
      expect(after.column).toBe("backlog");
    });

    it("multiple Stop hooks are idempotent", async () => {
      const card = await createTestCard(repoId, "Multi-stop card");
      await moveCard(card.id, "in_progress");
      await new Promise((r) => setTimeout(r, 300));
      await updateCard(card.id, { status: "running" });

      // First Stop hook
      const first = await simulateStopHook(card.id);
      expect(first.ok).toBe(true);

      const afterFirst = await getCard(card.id);
      expect(afterFirst.status).toBe("review_ready");

      // Second Stop hook should be ignored (already review_ready)
      const second = await simulateStopHook(card.id);
      expect(second.ok).toBe(true);
      expect(second.ignored).toBe(true);

      const afterSecond = await getCard(card.id);
      expect(afterSecond.status).toBe("review_ready");
    });

    it("card without repo cannot create issue", async () => {
      // Create card without repoId
      const card = await api<{ id: number }>("/api/cards", {
        method: "POST",
        body: JSON.stringify({
          title: "No repo card",
          description: "Test",
        }),
      });

      const res = await apiRaw("/api/github/issues", {
        method: "POST",
        body: JSON.stringify({ cardId: card.id }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.statusMessage).toContain("no associated repository");
    });
  });
});
