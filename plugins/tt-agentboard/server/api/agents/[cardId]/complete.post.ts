import { db } from "~~/server/db";
import { cards, workflowRuns } from "~~/server/db/schema";
import { eq } from "drizzle-orm";
import { tmuxManager } from "~~/server/services/tmux-manager";
import { eventBus } from "~~/server/utils/event-bus";
import { logger } from "~~/server/utils/logger";

/**
 * Callback endpoint for Claude Code Stop hook.
 * Called when Claude finishes responding in an agent session.
 *
 * Moves card to review but keeps tmux session alive so user can
 * inspect the terminal output. Session + slot are released when
 * the card is archived (moved to done).
 *
 * POST /api/agents/:cardId/complete
 */
export default defineEventHandler(async (event) => {
  const cardId = Number(getRouterParam(event, "cardId"));

  if (!cardId || Number.isNaN(cardId)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid cardId" });
  }

  logger.info(`Stop hook callback received for card ${cardId}`);

  // Fetch the card
  const cardRows = await db.select().from(cards).where(eq(cards.id, cardId));
  if (cardRows.length === 0) {
    throw createError({ statusCode: 404, statusMessage: "Card not found" });
  }
  const card = cardRows[0]!;

  // Only process if card is actually in_progress
  if (card.column !== "in_progress") {
    logger.warn(`Card ${cardId} not in_progress (${card.column}), ignoring callback`);
    return { ok: true, ignored: true };
  }

  // Update card to review — keep tmux session alive for inspection
  await db
    .update(cards)
    .set({
      column: "review",
      status: "review_ready",
      updatedAt: new Date(),
    })
    .where(eq(cards.id, cardId));

  // Update workflow run if exists
  await db
    .update(workflowRuns)
    .set({ status: "completed", endedAt: new Date() })
    .where(eq(workflowRuns.cardId, cardId));

  // Stop live capture polling but keep session alive
  const sessionName = `card-${cardId}`;
  tmuxManager.stopCapture(sessionName);

  // Emit events
  eventBus.emit("card:moved", {
    cardId,
    fromColumn: "in_progress",
    toColumn: "review",
  });
  eventBus.emit("card:status-changed", { cardId, status: "review_ready" });
  eventBus.emit("workflow:completed", { cardId, status: "completed" });

  logger.info(`Card ${cardId} completed via Stop hook, moved to review (tmux session preserved)`);

  return { ok: true };
});
