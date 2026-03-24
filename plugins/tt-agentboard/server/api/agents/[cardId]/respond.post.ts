import { db } from "~~/server/db";
import { cards } from "~~/server/db/schema";
import { eq } from "drizzle-orm";
import { tmuxManager } from "~~/server/services/tmux-manager";
import { eventBus } from "~~/server/utils/event-bus";
import { logger } from "~~/server/utils/logger";

/**
 * Send a user response to an agent waiting for input.
 * Types the response into the card's tmux session.
 *
 * POST /api/agents/:cardId/respond
 * Body: { response: string }
 */
export default defineEventHandler(async (event) => {
  const cardId = Number(getRouterParam(event, "cardId"));
  const body = await readBody(event);

  if (!cardId || Number.isNaN(cardId)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid cardId" });
  }

  if (!body?.response) {
    throw createError({ statusCode: 400, statusMessage: "Missing response field" });
  }

  const cardRows = await db.select().from(cards).where(eq(cards.id, cardId));
  if (cardRows.length === 0) {
    throw createError({ statusCode: 404, statusMessage: "Card not found" });
  }

  const sessionName = `card-${cardId}`;
  if (!tmuxManager.sessionExists(sessionName)) {
    throw createError({ statusCode: 409, statusMessage: "No tmux session for this card" });
  }

  // Send the response to the tmux session
  tmuxManager.sendCommand(sessionName, body.response);

  // Update status back to running
  await db
    .update(cards)
    .set({ status: "running", updatedAt: new Date() })
    .where(eq(cards.id, cardId));

  eventBus.emit("card:status-changed", { cardId, status: "running" });

  logger.info(`User responded to card ${cardId}: "${body.response.substring(0, 50)}..."`);

  return { ok: true };
});
