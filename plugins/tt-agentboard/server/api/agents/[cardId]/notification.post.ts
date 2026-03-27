import { eventBus } from "~~/server/shared/event-bus";
import { logger } from "~~/server/utils/logger";
import { getCardId, requireCard } from "~~/server/utils/params";
import { cardService } from "~~/server/domains/cards/card-service";

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

  await cardService.updateStatus(cardId, "waiting_input");
  eventBus.emit("agent:waiting", { cardId });

  return { ok: true };
});
