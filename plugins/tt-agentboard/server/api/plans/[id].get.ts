import { db } from "~~/server/db";
import { plans, cards } from "~~/server/db/schema";
import { eq } from "drizzle-orm";

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

  return {
    ...planRows[0],
    cards: planCards,
  };
});
