import { db } from "~~/server/db";
import { repositories, cards, boards } from "~~/server/db/schema";
import { eq, and } from "drizzle-orm";
import { getGitHubService } from "~~/server/services/github-service";

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const { repoId, triggerLabel } = body;

  if (!repoId || !triggerLabel) {
    throw createError({ statusCode: 400, statusMessage: "repoId and triggerLabel are required" });
  }

  const repo = await db.select().from(repositories).where(eq(repositories.id, repoId)).get();
  if (!repo || !repo.org || !repo.githubUrl) {
    throw createError({
      statusCode: 404,
      statusMessage: "Repository not found or missing org/github URL",
    });
  }

  const github = getGitHubService();
  const issues = await github.getIssuesWithLabel(repo.org, repo.name, triggerLabel);

  const created: number[] = [];

  for (const issue of issues) {
    // Check if a card already exists for this issue
    const existing = await db
      .select()
      .from(cards)
      .where(and(eq(cards.repoId, repoId), eq(cards.githubIssueNumber, issue.number)))
      .get();

    if (existing) continue;

    // Get or create default board
    const board = await db.select().from(boards).limit(1).get();
    if (!board) continue;

    const [card] = await db
      .insert(cards)
      .values({
        boardId: board.id,
        title: issue.title,
        description: issue.body ?? "",
        repoId,
        column: "ready",
        position: 0,
        githubIssueNumber: issue.number,
      })
      .returning();

    if (card) {
      created.push(card.id);
    }
  }

  return { synced: created.length, cardIds: created };
});
