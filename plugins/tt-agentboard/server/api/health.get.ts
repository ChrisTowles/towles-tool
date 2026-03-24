import { execSync } from "node:child_process";
import { isGitHubConfigured } from "~~/server/services/github-service";

export default defineEventHandler(() => {
  let tmuxInstalled = false;
  try {
    execSync("tmux -V", { stdio: "pipe" });
    tmuxInstalled = true;
  } catch {
    // tmux not found
  }

  const ghAuthenticated = isGitHubConfigured();

  return { tmuxInstalled, ghAuthenticated };
});
