import { db } from "~~/server/db";
import { cards, workflowRuns } from "~~/server/db/schema";
import { eq } from "drizzle-orm";
import { tmuxManager } from "~~/server/services/tmux-manager";
import { eventBus } from "~~/server/utils/event-bus";
import { logger } from "~~/server/utils/logger";
import { getCardId, requireCard } from "~~/server/utils/params";

/**
 * Callback endpoint for Claude Code StopFailure hook.
 * Called when Claude's turn ends due to an API error or crash.
 * Keeps tmux session alive for debugging.
 *
 * POST /api/agents/:cardId/failure
 */
export default defineEventHandler(async (event) => {
  const cardId = getCardId(event);

  logger.info(`StopFailure hook received for card ${cardId}`);

  const card = await requireCard(cardId);
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
