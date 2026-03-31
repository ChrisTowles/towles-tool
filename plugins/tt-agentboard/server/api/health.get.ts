import { execSync } from "node:child_process";
import { isGitHubConfigured } from "~~/server/domains/infra/github-service";
import { readConfig } from "~~/server/utils/config";

export default defineEventHandler(async () => {
  let tmuxInstalled = false;
  try {
    execSync("tmux -V", { stdio: "pipe" });
    tmuxInstalled = true;
  } catch {
    // tmux not found
  }

  const ghAuthenticated = await isGitHubConfigured();
  const config = readConfig();

  return { tmuxInstalled, ghAuthenticated, repoPaths: config.repoPaths };
});
