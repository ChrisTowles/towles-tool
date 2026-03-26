import { db } from "~~/server/db";
import { cards, cardEvents, workflowRuns, stepRuns, workspaceSlots } from "~~/server/db/schema";
import { eq } from "drizzle-orm";
import { tmuxManager } from "~~/server/services/tmux-manager";
import { eventBus } from "~~/server/utils/event-bus";

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"));

  // Kill tmux session if exists
  const sessionName = `card-${id}`;
  tmuxManager.stopCapture(sessionName);
  tmuxManager.killSession(sessionName);

  // Release any claimed workspace slots
  const claimedSlots = await db
    .select()
    .from(workspaceSlots)
    .where(eq(workspaceSlots.claimedByCardId, id));
  for (const slot of claimedSlots) {
    await db
      .update(workspaceSlots)
      .set({ status: "available", claimedByCardId: null })
      .where(eq(workspaceSlots.id, slot.id));
    eventBus.emit("slot:released", { slotId: slot.id });
  }

  // Delete related records (foreign key constraints)
  await db.delete(cardEvents).where(eq(cardEvents.cardId, id));

  // Delete step_runs via workflow_runs
  const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.cardId, id));
  for (const run of runs) {
    await db.delete(stepRuns).where(eq(stepRuns.workflowRunId, run.id));
  }
  await db.delete(workflowRuns).where(eq(workflowRuns.cardId, id));

  // Delete the card
  const result = await db.delete(cards).where(eq(cards.id, id)).returning();
  if (result.length === 0) {
    throw createError({ statusCode: 404, statusMessage: "Card not found" });
  }
  return { ok: true };
});
