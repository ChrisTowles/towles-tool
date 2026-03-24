import { db } from "~~/server/db";
import { cards, workflowRuns } from "~~/server/db/schema";
import { eq } from "drizzle-orm";
import { tmuxManager } from "~~/server/services/tmux-manager";
import { eventBus } from "~~/server/utils/event-bus";
import { logger } from "~~/server/utils/logger";

/**
 * Callback endpoint for Claude Code StopFailure hook.
 * Called when Claude's turn ends due to an API error or crash.
 * Keeps tmux session alive for debugging.
 *
 * POST /api/agents/:cardId/failure
 */
export default defineEventHandler(async (event) => {
  const cardId = Number(getRouterParam(event, "cardId"));

  if (!cardId || Number.isNaN(cardId)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid cardId" });
  }

  logger.info(`StopFailure hook received for card ${cardId}`);

  const cardRows = await db.select().from(cards).where(eq(cards.id, cardId));
  if (cardRows.length === 0) {
    throw createError({ statusCode: 404, statusMessage: "Card not found" });
  }

  const card = cardRows[0]!;
  if (card.column !== "in_progress") {
    return { ok: true, ignored: true };
  }

  await db
    .update(cards)
    .set({ status: "failed", updatedAt: new Date() })
    .where(eq(cards.id, cardId));

  await db
    .update(workflowRuns)
    .set({ status: "failed", endedAt: new Date() })
    .where(eq(workflowRuns.cardId, cardId));

  // Stop capture but keep session alive for debugging
  const sessionName = `card-${cardId}`;
  tmuxManager.stopCapture(sessionName);

  eventBus.emit("card:status-changed", { cardId, status: "failed" });
  eventBus.emit("workflow:completed", { cardId, status: "failed" });

  logger.info(`Card ${cardId} failed (StopFailure hook), tmux session preserved`);

  return { ok: true };
});
