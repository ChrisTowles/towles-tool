import { db } from "~~/server/shared/db";
import { workspaceSlots } from "~~/server/shared/db/schema";
import { eq } from "drizzle-orm";
import { eventBus } from "~~/server/shared/event-bus";
import { tmuxManager, cardSessionName } from "~~/server/domains/infra/tmux-manager";

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"));

  const [slot] = await db.select().from(workspaceSlots).where(eq(workspaceSlots.id, id));
  if (!slot) {
    throw createError({ statusCode: 404, statusMessage: "Slot not found" });
  }

  if (slot.status === "claimed" && slot.claimedByCardId) {
    const sessionName = cardSessionName(slot.claimedByCardId);
    if (tmuxManager.sessionExists(sessionName)) {
      throw createError({
        statusCode: 409,
        statusMessage: "Slot has an active agent session. Stop the agent first.",
      });
    }
  }

  const result = await db
    .update(workspaceSlots)
    .set({
      status: "available",
      claimedByCardId: null,
    })
    .where(eq(workspaceSlots.id, id))
    .returning();

  eventBus.emit("slot:released", { slotId: id });
  return result[0];
});
