import { isGitHubConfigured } from "~~/server/services/github-service";

export default defineEventHandler(() => {
  return { configured: isGitHubConfigured() };
});
