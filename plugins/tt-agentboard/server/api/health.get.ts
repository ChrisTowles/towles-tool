import { execSync } from "node:child_process";
import { isGitHubConfigured } from "~~/server/domains/infra/github-service";
import { readConfig } from "~~/server/utils/config";

export default defineEventHandler(() => {
  let tmuxInstalled = false;
  try {
    execSync("tmux -V", { stdio: "pipe" });
    tmuxInstalled = true;
  } catch {
    // tmux not found
  }

  const ghAuthenticated = isGitHubConfigured();
  const config = readConfig();

  return { tmuxInstalled, ghAuthenticated, repoPaths: config.repoPaths };
});
