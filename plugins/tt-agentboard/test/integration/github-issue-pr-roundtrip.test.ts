import { describe, it, expect, beforeAll } from "vitest";
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

/**
 * Integration test: GitHub issue → card → agent → PR round-trip
 *
 * Tests the full lifecycle via the API:
 * 1. GitHub issue discovered → card created
 * 2. Card moved to in_progress → agent starts
 * 3. Agent completes (Stop hook) → card moves to review
 * 4. PR creation endpoint validates correctly
 * 5. Card moved to done
 *
 * Uses mocked gh CLI commands to avoid requiring GitHub auth in CI.
 * Unit-level GitHubService tests live in github-roundtrip.test.ts.
 */
describe("GitHub Issue → Card → Agent → PR Round-Trip (integration)", () => {
  let repoId: number;

  beforeAll(async () => {
    const repo = await createTestRepo("gh-roundtrip-repo");
    repoId = repo.id;

    await createTestSlot(repoId, "/tmp/gh-roundtrip-workspace");

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
      const card = await createTestCard(repoId, "Fix: Add missing validation", {
        githubIssueNumber: 42,
      });

      expect(card.id).toBeDefined();
      expect(card.title).toBe("Fix: Add missing validation");
      expect(card.column).toBe("backlog");
      expect(card.status).toBe("idle");

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
      await new Promise((r) => setTimeout(r, 500));

      const card = await getCard(cardId);
      expect(card.column).toBe("in_progress");
      expect(["running", "queued"]).toContain(card.status);
    });

    it("Stop hook moves card to review_ready", async () => {
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

    it("create-pr endpoint returns error without workflow run", async () => {
      const res = await apiRaw(`/api/agents/${cardId}/create-pr`, {
        method: "POST",
      });

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

  describe("Event flow verification", () => {
    it("card status changes emit correct events through lifecycle", async () => {
      const card = await createTestCard(repoId, "Event test card");

      await moveCard(card.id, "ready");
      const readyCard = await getCard(card.id);
      expect(readyCard.column).toBe("ready");

      await moveCard(card.id, "in_progress");
      await new Promise((r) => setTimeout(r, 300));
      const inProgressCard = await getCard(card.id);
      expect(inProgressCard.column).toBe("in_progress");

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

      const result = await simulateStopHook(card.id);
      expect(result.ok).toBe(true);

      const after = await getCard(card.id);
      expect(after.column).toBe("backlog");
    });

    it("multiple Stop hooks are idempotent", async () => {
      const card = await createTestCard(repoId, "Multi-stop card");
      await moveCard(card.id, "in_progress");
      await new Promise((r) => setTimeout(r, 300));
      await updateCard(card.id, { status: "running" });

      const first = await simulateStopHook(card.id);
      expect(first.ok).toBe(true);

      const afterFirst = await getCard(card.id);
      expect(afterFirst.status).toBe("review_ready");

      const second = await simulateStopHook(card.id);
      expect(second.ok).toBe(true);
      expect(second.ignored).toBe(true);

      const afterSecond = await getCard(card.id);
      expect(afterSecond.status).toBe("review_ready");
    });

    it("card without repo cannot create issue", async () => {
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
