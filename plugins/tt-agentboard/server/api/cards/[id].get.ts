import { db } from "~~/server/db";
import { cards, repositories, workflowRuns } from "~~/server/db/schema";
import { eq, desc } from "drizzle-orm";

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"));
  const result = await db.select().from(cards).where(eq(cards.id, id));
  if (result.length === 0) {
    throw createError({ statusCode: 404, statusMessage: "Card not found" });
  }

  const card = result[0];

  // Fetch repo if linked
  let repo: { name: string; org: string | null; githubUrl: string | null } | null = null;
  if (card.repoId) {
    const repos = await db.select().from(repositories).where(eq(repositories.id, card.repoId));
    if (repos.length > 0) {
      repo = { name: repos[0].name, org: repos[0].org, githubUrl: repos[0].githubUrl };
    }
  }

  const runs = await db
    .select({ branch: workflowRuns.branch })
    .from(workflowRuns)
    .where(eq(workflowRuns.cardId, id))
    .orderBy(desc(workflowRuns.id))
    .limit(1);

  return {
    ...card,
    branch: runs[0]?.branch ?? null,
    repo,
  };
});
