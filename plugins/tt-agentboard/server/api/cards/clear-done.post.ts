import { db } from "~~/server/shared/db";
import { cards } from "~~/server/shared/db/schema";
import { eq } from "drizzle-orm";
import { cardService } from "~~/server/domains/cards/card-service";

/**
 * Delete all cards in the "done" column.
 * POST /api/cards/clear-done
 */
export default defineEventHandler(async () => {
  const doneCards = await db.select({ id: cards.id }).from(cards).where(eq(cards.status, "done"));

  for (const card of doneCards) {
    await cardService.deleteCard(card.id);
  }

  return { ok: true, cleared: doneCards.length };
});
