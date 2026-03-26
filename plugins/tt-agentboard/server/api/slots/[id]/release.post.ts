import { db } from "~~/server/db";
import { workspaceSlots } from "~~/server/db/schema";
import { eq } from "drizzle-orm";
import { eventBus } from "~~/server/utils/event-bus";

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"));

  const result = await db
    .update(workspaceSlots)
    .set({
      status: "available",
      claimedByCardId: null,
    })
    .where(eq(workspaceSlots.id, id))
    .returning();

  if (result.length === 0) {
    throw createError({ statusCode: 404, statusMessage: "Slot not found" });
  }

  eventBus.emit("slot:released", { slotId: id });
  return result[0];
});
