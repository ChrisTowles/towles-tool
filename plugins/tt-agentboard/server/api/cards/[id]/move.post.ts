import { db } from "~~/server/db";
import { cards } from "~~/server/db/schema";
import { eq } from "drizzle-orm";
import { agentExecutor } from "~~/server/services/agent-executor";
import { eventBus } from "~~/server/utils/event-bus";

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"));
  const body = await readBody(event);

  // Fetch current column before update
  const current = await db.select().from(cards).where(eq(cards.id, id));
  const fromColumn = current[0]?.column ?? "backlog";

  await db
    .update(cards)
    .set({
      column: body.column,
      position: body.position,
      updatedAt: new Date(),
    })
    .where(eq(cards.id, id));

  eventBus.emit("card:moved", {
    cardId: id,
    fromColumn,
    toColumn: body.column,
  });

  // If moved to in_progress, trigger agent execution
  if (body.column === "in_progress") {
    // Fire and forget — execution runs in background
    agentExecutor.startExecution(id).catch((err) => {
      eventBus.emit("card:status-changed", { cardId: id, status: "failed" });
      // Logger is used inside agentExecutor
    });
  }

  return { ok: true };
});
