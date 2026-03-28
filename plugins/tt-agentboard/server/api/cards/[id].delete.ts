import { db } from "~~/server/shared/db";
import { cards } from "~~/server/shared/db/schema";
import { eq } from "drizzle-orm";
import { cardService } from "~~/server/domains/cards/card-service";

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"));

  const existing = await db.select({ id: cards.id }).from(cards).where(eq(cards.id, id)).get();
  if (!existing) {
    throw createError({ statusCode: 404, statusMessage: "Card not found" });
  }

  await cardService.deleteCard(id);
  return { ok: true };
});
