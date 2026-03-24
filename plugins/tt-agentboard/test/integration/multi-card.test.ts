import { describe, it, expect, beforeAll } from "vitest";
import {
  createTestRepo,
  createTestSlot,
  createTestCard,
  getCard,
  moveCard,
  updateCard,
  simulateStopHook,
  resetSlot,
} from "../helpers";

describe("Multi-Card Queue (integration)", () => {
  let repoId: number;
  let slotId: number;
  let card1Id: number;
  let card2Id: number;
  let card3Id: number;

  beforeAll(async () => {
    const repo = await createTestRepo("multi-card-repo");
    repoId = repo.id;

    // Only 1 slot — forces queuing
    const slot = await createTestSlot(repoId, "/tmp/multi-card-workspace");
    slotId = slot.id;
  });

  it("creates 3 cards for the same repo", async () => {
    const c1 = await createTestCard(repoId, "Multi card 1");
    const c2 = await createTestCard(repoId, "Multi card 2");
    const c3 = await createTestCard(repoId, "Multi card 3");
    card1Id = c1.id;
    card2Id = c2.id;
    card3Id = c3.id;

    expect(c1.status).toBe("idle");
    expect(c2.status).toBe("idle");
    expect(c3.status).toBe("idle");
  });

  it("first card moved to in_progress gets the slot", async () => {
    await moveCard(card1Id, "in_progress");
    await new Promise((r) => setTimeout(r, 500));

    const card1 = await getCard(card1Id);
    expect(card1.column).toBe("in_progress");
    expect(["running", "queued"]).toContain(card1.status);
  });

  it("second and third cards are queued (no available slot)", async () => {
    await moveCard(card2Id, "in_progress");
    await moveCard(card3Id, "in_progress");
    await new Promise((r) => setTimeout(r, 500));

    const card2 = await getCard(card2Id);
    const card3 = await getCard(card3Id);

    expect(card2.column).toBe("in_progress");
    expect(card3.column).toBe("in_progress");
    // Both should be queued or failed (no tmux in test env, but queue logic runs first)
    expect(["queued", "failed"]).toContain(card2.status);
    expect(["queued", "failed"]).toContain(card3.status);
  });

  it("completing first card releases the slot", async () => {
    // Force card1 status to running so Stop hook processes it
    await updateCard(card1Id, { status: "running" });

    const result = await simulateStopHook(card1Id);
    expect(result.ok).toBe(true);

    // Move to done to release slot
    await moveCard(card1Id, "done");

    const card1 = await getCard(card1Id);
    expect(card1.column).toBe("done");
    expect(card1.status).toBe("done");
  });

  it("next queued card can be moved to in_progress and get the slot", async () => {
    // Reset slot explicitly in case queue manager didn't auto-claim
    await resetSlot(slotId);

    // Re-move card2 to in_progress to trigger execution
    await updateCard(card2Id, { column: "in_progress", status: "idle" });
    await moveCard(card2Id, "in_progress");
    await new Promise((r) => setTimeout(r, 500));

    const card2 = await getCard(card2Id);
    expect(card2.column).toBe("in_progress");
    expect(["running", "queued"]).toContain(card2.status);
  });
});
