import { db } from "~~/server/shared/db";
import { cards, repositories, workflowRuns } from "~~/server/shared/db/schema";
import { eq, desc, inArray } from "drizzle-orm";
import { cardService } from "~~/server/domains/cards/card-service";

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const boardId = Number(query.boardId) || 1;

  const rows = await db
    .select()
    .from(cards)
    .where(eq(cards.boardId, boardId))
    .orderBy(cards.position);

  // Batch-fetch repos for cards that have a repoId
  const repoIds = [...new Set(rows.map((c) => c.repoId).filter((id): id is number => id !== null))];
  const repoMap = new Map<number, { name: string; org: string | null; githubUrl: string | null }>();
  if (repoIds.length > 0) {
    const repos = await db.select().from(repositories).where(inArray(repositories.id, repoIds));
    for (const r of repos) {
      repoMap.set(r.id, { name: r.name, org: r.org, githubUrl: r.githubUrl });
    }
  }

  // Batch-fetch latest branch from workflowRuns for all cards
  const branches = new Map<number, string>();
  if (rows.length > 0) {
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

  // Batch-fetch dependencies for all cards
  const cardIds = rows.map((c) => c.id);
  const depsMap = await cardService.getDepsMap(cardIds);

  return rows.map((card) => ({
    ...card,
    dependsOn: depsMap.get(card.id) ?? [],
    branch: branches.get(card.id) ?? null,
    repo: card.repoId ? (repoMap.get(card.repoId) ?? null) : null,
  }));
});
