import { execSync } from "node:child_process";

export default defineEventHandler(() => {
  let tmuxInstalled = false;
  try {
    execSync("tmux -V", { stdio: "pipe" });
    tmuxInstalled = true;
  } catch {
    // tmux not found
  }

  const githubToken = Boolean(process.env.GITHUB_TOKEN);

  return { tmuxInstalled, githubToken };
});
