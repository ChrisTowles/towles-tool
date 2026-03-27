import { db } from "~~/server/shared/db";
import { cardEvents } from "~~/server/shared/db/schema";
import { eq, desc } from "drizzle-orm";

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"));
  if (!id || Number.isNaN(id)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid card ID" });
  }

  return db
    .select()
    .from(cardEvents)
    .where(eq(cardEvents.cardId, id))
    .orderBy(desc(cardEvents.timestamp))
    .limit(50);
});
