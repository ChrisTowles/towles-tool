import { db } from "~~/server/shared/db";
import { cards } from "~~/server/shared/db/schema";
import { eq } from "drizzle-orm";

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"));
  if (!id || Number.isNaN(id)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid card id" });
  }

  const { issueNumber } = await readBody<{ issueNumber: number }>(event);
  if (!issueNumber) {
    throw createError({ statusCode: 400, statusMessage: "issueNumber is required" });
  }

  const result = await db
    .update(cards)
    .set({ githubIssueNumber: issueNumber, updatedAt: new Date() })
    .where(eq(cards.id, id))
    .returning();

  if (result.length === 0) {
    throw createError({ statusCode: 404, statusMessage: "Card not found" });
  }

  return result[0];
});
