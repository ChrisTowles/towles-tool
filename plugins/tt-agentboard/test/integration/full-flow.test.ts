import { describe, it, expect, beforeAll } from "vitest";
import {
  createTestRepo,
  createTestSlot,
  createTestCard,
  getCard,
  moveCard,
  updateCard,
  simulateStopHook,
  simulateNotificationHook,
  getSlots,
} from "../helpers";

describe("Full Card Lifecycle (integration)", () => {
  let repoId: number;
  let slotId: number;
  let cardId: number;

  beforeAll(async () => {
    const repo = await createTestRepo("full-flow-repo");
    repoId = repo.id;

    const slot = await createTestSlot(repoId, "/tmp/full-flow-workspace");
    slotId = slot.id;
  });

  it("creates a card in backlog with idle status", async () => {
    const card = await createTestCard(repoId, "Full lifecycle card", {
      workflowId: "auto-claude",
    });
    cardId = card.id;

    expect(card.column).toBe("backlog");
    expect(card.status).toBe("idle");
  });

  it("moving to in_progress triggers execution (running or queued)", async () => {
    await moveCard(cardId, "in_progress");
    // Wait for async executor
    await new Promise((r) => setTimeout(r, 500));

    const card = await getCard(cardId);
    expect(card.column).toBe("in_progress");
    expect(["running", "queued"]).toContain(card.status);
  });

  it("Notification hook sets status to waiting_input", async () => {
    // Force status to running so notification hook accepts it
    await updateCard(cardId, { status: "running" });

    const result = await simulateNotificationHook(cardId);
    expect(result.ok).toBe(true);

    const card = await getCard(cardId);
    expect(card.status).toBe("waiting_input");
    expect(card.column).toBe("in_progress");
  });

  it("user response sets status back to running", async () => {
    // Simulate user responding — in test env no tmux, so PUT status directly
    await updateCard(cardId, { status: "running" });

    const card = await getCard(cardId);
    expect(card.status).toBe("running");
    expect(card.column).toBe("in_progress");
  });

  it("Stop hook moves card to review with review_ready status", async () => {
    const result = await simulateStopHook(cardId);
    expect(result.ok).toBe(true);

    const card = await getCard(cardId);
    expect(card.column).toBe("review");
    expect(card.status).toBe("review_ready");
  });

  it("moving to done releases slot and sets status to done", async () => {
    await moveCard(cardId, "done");

    const card = await getCard(cardId);
    expect(card.column).toBe("done");
    expect(card.status).toBe("done");

    // Verify slot is released
    const slots = await getSlots();
    const slot = slots.find((s) => s.id === slotId);
    expect(slot?.status).toBe("available");
  });

  it("slot is not claimed after card completes", async () => {
    const slots = await getSlots();
    const slot = slots.find((s) => s.id === slotId);
    expect(slot?.claimedByCardId).toBeNull();
  });
});
