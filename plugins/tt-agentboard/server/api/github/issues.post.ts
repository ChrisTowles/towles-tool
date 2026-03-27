import { db } from "~~/server/shared/db";
import { cards, repositories } from "~~/server/shared/db/schema";
import { eq } from "drizzle-orm";
import { getGitHubService } from "~~/server/domains/infra/github-service";

export default defineEventHandler(async (event) => {
  const { cardId } = await readBody<{ cardId: number }>(event);

  if (!cardId) {
    throw createError({ statusCode: 400, statusMessage: "cardId is required" });
  }

  const cardRows = await db.select().from(cards).where(eq(cards.id, cardId));
  if (cardRows.length === 0) {
    throw createError({ statusCode: 404, statusMessage: "Card not found" });
  }
  const card = cardRows[0]!;

  if (!card.repoId) {
    throw createError({ statusCode: 400, statusMessage: "Card has no associated repository" });
  }

  if (card.githubIssueNumber) {
    throw createError({ statusCode: 409, statusMessage: "Card already has a GitHub issue" });
  }

  const repoRows = await db.select().from(repositories).where(eq(repositories.id, card.repoId));
  if (repoRows.length === 0) {
    throw createError({ statusCode: 404, statusMessage: "Repository not found" });
  }
  const repo = repoRows[0]!;

  if (!repo.org || !repo.name) {
    throw createError({ statusCode: 400, statusMessage: "Repository missing org or name" });
  }

  const github = getGitHubService();
  const issue = await github.createIssue(repo.org, repo.name, card.title, card.description ?? "");

  await db
    .update(cards)
    .set({ githubIssueNumber: issue.number, updatedAt: new Date() })
    .where(eq(cards.id, cardId));

  return { issueNumber: issue.number, htmlUrl: issue.html_url };
});
