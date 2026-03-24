import { db } from "~~/server/db";
import { cards } from "~~/server/db/schema";
import { eq } from "drizzle-orm";
import { eventBus } from "~~/server/utils/event-bus";
import { logger } from "~~/server/utils/logger";

/**
 * Callback endpoint for Claude Code Notification hook.
 * Called when Claude needs user input or attention.
 *
 * POST /api/agents/:cardId/notification
 */
export default defineEventHandler(async (event) => {
  const cardId = Number(getRouterParam(event, "cardId"));

  if (!cardId || Number.isNaN(cardId)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid cardId" });
  }

  logger.info(`Notification hook received for card ${cardId}`);

  const cardRows = await db.select().from(cards).where(eq(cards.id, cardId));
  if (cardRows.length === 0) {
    throw createError({ statusCode: 404, statusMessage: "Card not found" });
  }

  const card = cardRows[0]!;
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
