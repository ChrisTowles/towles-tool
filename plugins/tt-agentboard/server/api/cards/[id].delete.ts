import { db } from "~~/server/db";
import { cards, cardEvents, workflowRuns, stepRuns } from "~~/server/db/schema";
import { eq } from "drizzle-orm";
import { tmuxManager } from "~~/server/services/tmux-manager";

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"));

  // Kill tmux session if exists
  const sessionName = `card-${id}`;
  tmuxManager.stopCapture(sessionName);
  tmuxManager.killSession(sessionName);

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
