import { isGitHubConfigured } from "~~/server/domains/infra/github-service";

export default defineEventHandler(() => {
  return { configured: isGitHubConfigured() };
});
