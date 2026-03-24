import { getGitHubService } from "~~/server/services/github-service";

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const owner = String(query.owner);
  const repo = String(query.repo);
  const label = String(query.label);

  if (!owner || !repo || !label) {
    throw createError({
      statusCode: 400,
      statusMessage: "owner, repo, and label query params are required",
    });
  }

  const github = getGitHubService();
  return github.getIssuesWithLabel(owner, repo, label);
});
