import { db } from "../db";
import { cards, workspaceSlots } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { agentExecutor } from "../services/agent-executor";
import { eventBus } from "../utils/event-bus";
import { logger } from "../utils/logger";
import { logCardEvent } from "../utils/card-events";

const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_AGENTS) || 3;

async function tryAutoStartNext(slot: { id: number; repoId: number | null }): Promise<boolean> {
  // Check current running count across all repos
  const runningCards = await db.select().from(cards).where(eq(cards.status, "running"));

  if (runningCards.length >= MAX_CONCURRENT) {
    logger.info(
      `Queue: ${runningCards.length}/${MAX_CONCURRENT} agents running, skipping auto-start`,
    );
    return false;
  }

  // Find next queued card (any column — queued cards may be in "ready" column)
  let queued = await db
    .select()
    .from(cards)
    .where(and(eq(cards.repoId, slot.repoId), eq(cards.status, "queued")))
    .orderBy(cards.position)
    .limit(1);

  // Fall back to idle cards in the "ready" column
  if (queued.length === 0) {
    queued = await db
      .select()
      .from(cards)
      .where(
        and(eq(cards.repoId, slot.repoId), eq(cards.column, "ready"), eq(cards.status, "idle")),
      )
      .orderBy(cards.position)
      .limit(1);
  }

  if (queued.length === 0) {
    logger.info(`Queue: no queued or ready cards for repo ${slot.repoId}`);
    return false;
  }

  const nextCard = queued[0]!;
  const isReadyCard = nextCard.status === "idle" && nextCard.column === "ready";
  logger.info(
    `Queue: auto-starting card ${nextCard.id} (${isReadyCard ? "ready/idle" : "queued"}) for repo ${slot.repoId}`,
  );

  // Pre-claim the released slot for this card to avoid race conditions
  await db
    .update(workspaceSlots)
    .set({ status: "claimed", claimedByCardId: nextCard.id })
    .where(eq(workspaceSlots.id, slot.id));

  // Move card to in_progress
  await db
    .update(cards)
    .set({ column: "in_progress", updatedAt: new Date() })
    .where(eq(cards.id, nextCard.id));

  eventBus.emit("card:moved", {
    cardId: nextCard.id,
    fromColumn: nextCard.column,
    toColumn: "in_progress",
  });

  if (isReadyCard) {
    await logCardEvent(
      nextCard.id,
      "auto_started",
      `Auto-promoted from ready column (slot ${slot.id} became available)`,
    );
  }

  agentExecutor.startExecution(nextCard.id).catch((err) => {
    logger.error(`Queue: failed to start card ${nextCard.id}:`, err);
    eventBus.emit("card:status-changed", { cardId: nextCard.id, status: "failed" });
  });

  return true;
}

export default defineNitroPlugin(() => {
  eventBus.on("slot:released", async (data: { slotId: number }) => {
    try {
      const [slot] = await db
        .select()
        .from(workspaceSlots)
        .where(eq(workspaceSlots.id, data.slotId));
      if (!slot) return;
      await tryAutoStartNext(slot);
    } catch (err) {
      logger.error("Queue: error processing slot:released:", err);
    }
  });

  // When a card completes or fails, check if ready cards can be auto-started
  eventBus.on("card:status-changed", async (data: { cardId: number; status: string }) => {
    if (data.status !== "review_ready" && data.status !== "done" && data.status !== "failed") {
      return;
    }

    try {
      // Check current running count
      const runningCards = await db.select().from(cards).where(eq(cards.status, "running"));

      if (runningCards.length >= MAX_CONCURRENT) return;

      // Find all available slots
      const availableSlots = await db
        .select()
        .from(workspaceSlots)
        .where(eq(workspaceSlots.status, "available"));

      let started = 0;
      for (const slot of availableSlots) {
        if (runningCards.length + started >= MAX_CONCURRENT) break;

        const didStart = await tryAutoStartNext(slot);
        if (didStart) started++;
      }
    } catch (err) {
      logger.error("Queue: error processing card:status-changed for auto-start:", err);
    }
  });

  logger.info(`Queue manager active (max concurrent: ${MAX_CONCURRENT})`);
});
