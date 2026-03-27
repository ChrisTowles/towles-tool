import { db } from "~~/server/shared/db";
import { plans, cards, cardDependencies } from "~~/server/shared/db/schema";
import { eq, inArray } from "drizzle-orm";

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
  const depsMap = new Map<number, number[]>();
  if (cardIds.length > 0) {
    const deps = await db
      .select()
      .from(cardDependencies)
      .where(inArray(cardDependencies.cardId, cardIds));
    for (const dep of deps) {
      const existing = depsMap.get(dep.cardId) ?? [];
      existing.push(dep.dependsOnCardId);
      depsMap.set(dep.cardId, existing);
    }
  }

  return {
    ...planRows[0],
    cards: planCards.map((card) => ({
      ...card,
      dependsOn: depsMap.get(card.id) ?? [],
    })),
  };
});
