import { db } from "../db";
import { cards, workspaceSlots } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { agentExecutor } from "../services/agent-executor";
import { eventBus } from "../utils/event-bus";
import { logger } from "../utils/logger";

const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_AGENTS) || 3;

export default defineNitroPlugin(() => {
  eventBus.on("slot:released", async (data: { slotId: number }) => {
    try {
      // Find which repo this slot belongs to
      const slotRows = await db
        .select()
        .from(workspaceSlots)
        .where(eq(workspaceSlots.id, data.slotId));

      if (slotRows.length === 0) return;
      const slot = slotRows[0]!;

      // Check current running count across all repos
      const runningCards = await db
        .select()
        .from(cards)
        .where(eq(cards.status, "running"));

      if (runningCards.length >= MAX_CONCURRENT) {
        logger.info(
          `Queue: ${runningCards.length}/${MAX_CONCURRENT} agents running, skipping auto-start`,
        );
        return;
      }

      // Find next queued card for this repo
      const queued = await db
        .select()
        .from(cards)
        .where(and(eq(cards.repoId, slot.repoId), eq(cards.status, "queued")))
        .orderBy(cards.position)
        .limit(1);

      if (queued.length === 0) {
        logger.info(`Queue: no queued cards for repo ${slot.repoId}`);
        return;
      }

      const nextCard = queued[0]!;
      logger.info(`Queue: auto-starting card ${nextCard.id} for repo ${slot.repoId}`);

      // Move card to in_progress and trigger execution
      await db
        .update(cards)
        .set({ column: "in_progress", updatedAt: new Date() })
        .where(eq(cards.id, nextCard.id));

      eventBus.emit("card:moved", {
        cardId: nextCard.id,
        fromColumn: nextCard.column,
        toColumn: "in_progress",
      });

      agentExecutor.startExecution(nextCard.id).catch((err) => {
        logger.error(`Queue: failed to start card ${nextCard.id}:`, err);
        eventBus.emit("card:status-changed", { cardId: nextCard.id, status: "failed" });
      });
    } catch (err) {
      logger.error("Queue: error processing slot:released:", err);
    }
  });

  logger.info(`Queue manager active (max concurrent: ${MAX_CONCURRENT})`);
});
