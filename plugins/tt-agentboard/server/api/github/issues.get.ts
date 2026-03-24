import { db } from "~~/server/db";
import { repositories } from "~~/server/db/schema";
import { eq } from "drizzle-orm";
import { getGitHubService } from "~~/server/services/github-service";

export default defineEventHandler(async (event) => {
  const query = getQuery(event);

  let owner: string;
  let repo: string;
  const label = query.label ? String(query.label) : undefined;

  if (query.repoId) {
    const repoId = Number(query.repoId);
    const rows = await db.select().from(repositories).where(eq(repositories.id, repoId));
    if (rows.length === 0) {
      throw createError({ statusCode: 404, statusMessage: "Repository not found" });
    }
    const repoRow = rows[0]!;
    if (!repoRow.org || !repoRow.name) {
      throw createError({ statusCode: 400, statusMessage: "Repository missing org or name" });
    }
    owner = repoRow.org;
    repo = repoRow.name;
  } else if (query.owner && query.repo) {
    owner = String(query.owner);
    repo = String(query.repo);
  } else {
    throw createError({
      statusCode: 400,
      statusMessage: "Either repoId or owner+repo query params are required",
    });
  }

  const github = getGitHubService();

  if (label) {
    return github.getIssuesWithLabel(owner, repo, label);
  }

  // Fetch all open issues without label filter
  return github.getOpenIssues(owner, repo);
});
