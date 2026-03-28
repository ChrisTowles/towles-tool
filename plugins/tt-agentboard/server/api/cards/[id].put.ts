import { db } from "~~/server/shared/db";
import { cards, cardDependencies } from "~~/server/shared/db/schema";
import { eq } from "drizzle-orm";

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"));
  const body = await readBody(event);

  // Extract dependsOn from body — handle as array of card IDs
  const { dependsOn, ...cardFields } = body;

  const result = await db
    .update(cards)
    .set({
      ...cardFields,
      updatedAt: new Date(),
    })
    .where(eq(cards.id, id))
    .returning();
  if (result.length === 0) {
    throw createError({ statusCode: 404, statusMessage: "Card not found" });
  }

  // If dependsOn was provided, replace all dependency rows
  if (dependsOn !== undefined) {
    await db.delete(cardDependencies).where(eq(cardDependencies.cardId, id));

    const depIds: number[] = Array.isArray(dependsOn)
      ? dependsOn.map(Number).filter((n: number) => !Number.isNaN(n) && n > 0)
      : [];

    if (depIds.length > 0) {
      await db.insert(cardDependencies).values(
        depIds.map((depId: number) => ({
          cardId: id,
          dependsOnCardId: depId,
        })),
      );
    }
  }

  return result[0];
});
