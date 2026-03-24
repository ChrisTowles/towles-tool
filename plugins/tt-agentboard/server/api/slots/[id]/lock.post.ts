import { db } from "~~/server/db";
import { workspaceSlots } from "~~/server/db/schema";
import { eq } from "drizzle-orm";

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"));
  const body = await readBody(event);
  const locked = body.locked !== false;

  const result = await db
    .update(workspaceSlots)
    .set({
      status: locked ? "locked" : "available",
      claimedByCardId: locked ? null : undefined,
    })
    .where(eq(workspaceSlots.id, id))
    .returning();

  if (result.length === 0) {
    throw createError({ statusCode: 404, statusMessage: "Slot not found" });
  }
  return result[0];
});
