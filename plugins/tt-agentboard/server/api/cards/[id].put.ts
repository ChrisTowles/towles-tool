import { db } from "~~/server/db";
import { cards } from "~~/server/db/schema";
import { eq } from "drizzle-orm";

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"));
  const body = await readBody(event);
  const result = await db
    .update(cards)
    .set({
      ...body,
      updatedAt: new Date(),
    })
    .where(eq(cards.id, id))
    .returning();
  if (result.length === 0) {
    throw createError({ statusCode: 404, statusMessage: "Card not found" });
  }
  return result[0];
});
