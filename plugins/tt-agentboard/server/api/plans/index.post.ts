import { db } from "~~/server/shared/db";
import { plans } from "~~/server/shared/db/schema";

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const result = await db
    .insert(plans)
    .values({
      name: body.name,
      description: body.description,
      prGranularity: body.prGranularity || "per_card",
    })
    .returning();
  return result[0];
});
