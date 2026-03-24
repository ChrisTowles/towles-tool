import { describe, it, expect, beforeAll } from "vitest";
import {
  api,
  createTestRepo,
  createTestSlot,
  createTestCard,
  getCard,
  moveCard,
  updateCard,
  simulateStopHook,
  simulateFailureHook,
  resetSlot,
} from "../helpers";

describe("Error Recovery (integration)", () => {
  let repoId: number;
  let slotId: number;

  beforeAll(async () => {
    const repo = await createTestRepo("error-recovery-repo");
    repoId = repo.id;

    const slot = await createTestSlot(repoId, "/tmp/error-recovery-workspace");
    slotId = slot.id;
  });

  describe("card with no repoId", () => {
    it("fails when moved to in_progress without a repo", async () => {
      // Create card without repoId by creating with repo then removing it
      const card = await api<{ id: number }>("/api/cards", {
        method: "POST",
        body: JSON.stringify({ title: "No repo card", description: "Should fail" }),
      });

      await moveCard(card.id, "in_progress");
      await new Promise((r) => setTimeout(r, 500));

      const status = await getCard(card.id);
      expect(status.column).toBe("in_progress");
      // Without repoId, agent executor sets failed
      expect(["failed", "idle"]).toContain(status.status);
    });
  });

  describe("card with repoId but no slots", () => {
    it("is queued when no slots exist for its repo", async () => {
      const noSlotRepo = await createTestRepo("no-slot-repo");
      const card = await createTestCard(noSlotRepo.id, "No slot card");

      await moveCard(card.id, "in_progress");
      await new Promise((r) => setTimeout(r, 500));

      const status = await getCard(card.id);
      expect(status.column).toBe("in_progress");
      expect(["queued", "failed"]).toContain(status.status);
    });
  });

  describe("StopFailure hook", () => {
    let cardId: number;

    it("sets card to failed status", async () => {
      await resetSlot(slotId);
      const card = await createTestCard(repoId, "Failure hook card");
      cardId = card.id;

      await moveCard(cardId, "in_progress");
      await new Promise((r) => setTimeout(r, 500));

      // Force running so failure hook accepts it
      await updateCard(cardId, { status: "running" });

      const result = await simulateFailureHook(cardId);
      expect(result.ok).toBe(true);

      const status = await getCard(cardId);
      expect(status.column).toBe("in_progress");
      expect(status.status).toBe("failed");
    });

    it("can retry by moving back to in_progress after failure", async () => {
      await resetSlot(slotId);

      // Reset card state to allow re-execution
      await updateCard(cardId, { column: "backlog", status: "idle" });

      await moveCard(cardId, "in_progress");
      await new Promise((r) => setTimeout(r, 500));

      const status = await getCard(cardId);
      expect(status.column).toBe("in_progress");
      expect(["running", "queued"]).toContain(status.status);
    });
  });

  describe("double completion (idempotency)", () => {
    it("second Stop hook is ignored after first completion", async () => {
      await resetSlot(slotId);
      const card = await createTestCard(repoId, "Double complete card");

      await moveCard(card.id, "in_progress");
      await new Promise((r) => setTimeout(r, 500));

      // Force running status
      await updateCard(card.id, { status: "running" });

      // First Stop hook — succeeds
      const result1 = await simulateStopHook(card.id);
      expect(result1.ok).toBe(true);
      expect(result1.ignored).toBeUndefined();

      const afterFirst = await getCard(card.id);
      expect(afterFirst.column).toBe("review");
      expect(afterFirst.status).toBe("review_ready");

      // Second Stop hook — card is now in review, not in_progress → ignored
      const result2 = await simulateStopHook(card.id);
      expect(result2.ok).toBe(true);
      expect(result2.ignored).toBe(true);

      // Status unchanged
      const afterSecond = await getCard(card.id);
      expect(afterSecond.column).toBe("review");
      expect(afterSecond.status).toBe("review_ready");
    });
  });

  describe("complete then done then complete again", () => {
    it("Stop hook is ignored after card is moved to done", async () => {
      await resetSlot(slotId);
      const card = await createTestCard(repoId, "Done then complete card");

      await moveCard(card.id, "in_progress");
      await new Promise((r) => setTimeout(r, 500));
      await updateCard(card.id, { status: "running" });

      // Complete
      await simulateStopHook(card.id);
      const afterComplete = await getCard(card.id);
      expect(afterComplete.column).toBe("review");

      // Move to done
      await moveCard(card.id, "done");
      const afterDone = await getCard(card.id);
      expect(afterDone.column).toBe("done");
      expect(afterDone.status).toBe("done");

      // Try to complete again — card is in done, not in_progress → ignored
      const result = await simulateStopHook(card.id);
      expect(result.ok).toBe(true);
      expect(result.ignored).toBe(true);

      // Status still done
      const final = await getCard(card.id);
      expect(final.column).toBe("done");
      expect(final.status).toBe("done");
    });
  });
});
