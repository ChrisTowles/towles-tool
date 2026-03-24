import { db } from "~~/server/db";
import { cards, workflowRuns } from "~~/server/db/schema";
import { eq, desc } from "drizzle-orm";

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const boardId = Number(query.boardId) || 1;

  const rows = await db
    .select()
    .from(cards)
    .where(eq(cards.boardId, boardId))
    .orderBy(cards.position);

  // Batch-fetch latest branch from workflowRuns for all cards
  const cardIds = rows.map((c) => c.id);
  const branches = new Map<number, string>();
  if (cardIds.length > 0) {
    const runs = await db
      .select({ cardId: workflowRuns.cardId, branch: workflowRuns.branch })
      .from(workflowRuns)
      .orderBy(desc(workflowRuns.id));
    for (const run of runs) {
      if (run.branch && !branches.has(run.cardId)) {
        branches.set(run.cardId, run.branch);
      }
    }
  }

  return rows.map((card) => ({
    ...card,
    branch: branches.get(card.id) ?? null,
  }));
});
