import { db } from "~~/server/db";
import { cards } from "~~/server/db/schema";
import { eq } from "drizzle-orm";
import { eventBus } from "~~/server/utils/event-bus";
import { logger } from "~~/server/utils/logger";
import { getCardId, requireCard } from "~~/server/utils/params";

/**
 * Callback endpoint for Claude Code Notification hook.
 * Called when Claude needs user input or attention.
 *
 * POST /api/agents/:cardId/notification
 */
export default defineEventHandler(async (event) => {
  const cardId = getCardId(event);

  logger.info(`Notification hook received for card ${cardId}`);

  const card = await requireCard(cardId);
  if (card.status !== "running") {
    return { ok: true, ignored: true };
  }

  await db
    .update(cards)
    .set({ status: "waiting_input", updatedAt: new Date() })
    .where(eq(cards.id, cardId));

  eventBus.emit("card:status-changed", { cardId, status: "waiting_input" });
  eventBus.emit("agent:waiting", { cardId });

  return { ok: true };
});
