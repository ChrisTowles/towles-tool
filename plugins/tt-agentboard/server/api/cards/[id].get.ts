import { db } from "~~/server/db";
import { cards, workflowRuns } from "~~/server/db/schema";
import { eq, desc } from "drizzle-orm";

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"));
  const result = await db.select().from(cards).where(eq(cards.id, id));
  if (result.length === 0) {
    throw createError({ statusCode: 404, statusMessage: "Card not found" });
  }

  const runs = await db
    .select({ branch: workflowRuns.branch })
    .from(workflowRuns)
    .where(eq(workflowRuns.cardId, id))
    .orderBy(desc(workflowRuns.id))
    .limit(1);

  return {
    ...result[0],
    branch: runs[0]?.branch ?? null,
  };
});
