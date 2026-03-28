import { db } from "~~/server/shared/db";
import { plans, cards } from "~~/server/shared/db/schema";
import { eq } from "drizzle-orm";
import { cardService } from "~~/server/domains/cards/card-service";

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"));

  const planRows = await db.select().from(plans).where(eq(plans.id, id));
  if (planRows.length === 0) {
    throw createError({ statusCode: 404, statusMessage: "Plan not found" });
  }

  const planCards = await db
    .select()
    .from(cards)
    .where(eq(cards.planId, id))
    .orderBy(cards.position);

  // Batch-fetch dependencies for all plan cards
  const cardIds = planCards.map((c) => c.id);
  const depsMap = await cardService.getDepsMap(cardIds);

  return {
    ...planRows[0],
    cards: planCards.map((card) => ({
      ...card,
      dependsOn: depsMap.get(card.id) ?? [],
    })),
  };
});
