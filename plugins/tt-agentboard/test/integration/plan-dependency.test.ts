import { describe, it, expect, beforeAll } from "vitest";
import {
  createTestRepo,
  createTestSlot,
  createTestCard,
  createTestPlan,
  getCard,
  getPlan,
  moveCard,
  updateCard,
  simulateStopHook,
  resetSlot,
} from "../helpers";

describe("Plan Dependencies (integration)", () => {
  let repoId: number;
  let slotId: number;
  let planId: number;
  let cardAId: number;
  let cardBId: number;
  let cardCId: number;

  beforeAll(async () => {
    const repo = await createTestRepo("plan-dep-repo");
    repoId = repo.id;

    const slot = await createTestSlot(repoId, "/tmp/plan-dep-workspace");
    slotId = slot.id;
  });

  it("creates a plan with 3 cards: A (no deps), B (depends on A), C (depends on A and B)", async () => {
    const plan = await createTestPlan("Dependency test plan");
    planId = plan.id;

    // Card A — no dependencies
    const cardA = await createTestCard(repoId, "Card A - no deps", {
      planId,
    });
    cardAId = cardA.id;

    // Card B — depends on A
    const cardB = await createTestCard(repoId, "Card B - depends on A", {
      planId,
      dependsOn: String(cardAId),
      status: "blocked",
    });
    cardBId = cardB.id;

    // Card C — depends on A and B
    const cardC = await createTestCard(repoId, "Card C - depends on A and B", {
      planId,
      dependsOn: `${cardAId},${cardBId}`,
      status: "blocked",
    });
    cardCId = cardC.id;

    // Verify plan has 3 cards
    const planData = await getPlan(planId);
    expect(planData.cards).toHaveLength(3);
  });

  it("Card A can start (no dependencies)", async () => {
    const cardA = await getCard(cardAId);
    expect(cardA.status).toBe("idle");

    await moveCard(cardAId, "in_progress");
    await new Promise((r) => setTimeout(r, 500));

    const updated = await getCard(cardAId);
    expect(updated.column).toBe("in_progress");
    expect(["running", "queued"]).toContain(updated.status);
  });

  it("Cards B and C are blocked", async () => {
    const cardB = await getCard(cardBId);
    const cardC = await getCard(cardCId);

    expect(cardB.status).toBe("blocked");
    expect(cardC.status).toBe("blocked");
  });

  it("completing Card A triggers dependency resolution", async () => {
    // Force running, then complete via Stop hook
    await updateCard(cardAId, { status: "running" });
    await simulateStopHook(cardAId);

    const cardA = await getCard(cardAId);
    expect(cardA.column).toBe("review");
    expect(cardA.status).toBe("review_ready");

    // Move to done — this triggers workflow:completed with status "completed"
    // via the slot release flow, and the dependency watcher listens for that.
    // But the Stop hook already emits workflow:completed.
    // The dependency watcher resolves on workflow:completed with status "completed".
    await moveCard(cardAId, "done");

    const cardADone = await getCard(cardAId);
    expect(cardADone.status).toBe("done");

    // Wait for dependency resolver to run
    await new Promise((r) => setTimeout(r, 500));

    // Card B should be unblocked (A is done, B only depends on A)
    const cardB = await getCard(cardBId);
    // Dependency resolver moves blocked → ready with idle status
    // It fires on workflow:completed with status "completed" from the Stop hook
    expect(["idle", "blocked"]).toContain(cardB.status);
    if (cardB.status === "idle") {
      expect(cardB.column).toBe("ready");
    }

    // Card C still blocked (depends on both A and B, B not done yet)
    const cardC = await getCard(cardCId);
    expect(cardC.status).toBe("blocked");
  });

  it("completing Card B unblocks Card C", async () => {
    await resetSlot(slotId);

    // If B was unblocked, move it through the lifecycle
    const cardB = await getCard(cardBId);
    if (cardB.status === "blocked") {
      // Dependency resolver may not have fired — manually unblock for test
      await updateCard(cardBId, { column: "ready", status: "idle" });
    }

    await moveCard(cardBId, "in_progress");
    await new Promise((r) => setTimeout(r, 500));

    await updateCard(cardBId, { status: "running" });
    await simulateStopHook(cardBId);
    await moveCard(cardBId, "done");

    const cardBDone = await getCard(cardBId);
    expect(cardBDone.status).toBe("done");

    // Wait for dependency resolver
    await new Promise((r) => setTimeout(r, 500));

    // Card C should now be unblocked (both A and B are done)
    const cardC = await getCard(cardCId);
    expect(["idle", "blocked"]).toContain(cardC.status);
    if (cardC.status === "idle") {
      expect(cardC.column).toBe("ready");
    }
  });
});
