// unJs/changelogen has some nice utilities for git
import { execCommand } from "../exec";

// using logic from https://github.com/unjs/changelogen/blob/main/src/git.ts

export async function getGitDiff(cwd: string): Promise<string> {
  // https://git-scm.com/docs/pretty-formats
  let r = execCommand(
    // `git --no-pager log "${from ? `${from}...` : ''}${to}"  `,
    // using --cached because staged didn't work on MacOS
    `git --no-pager diff --cached`,
    // --name-status
    // --pretty="----%n%s|%h|%an|%ae%n%b"
    cwd,
  );

  // Limit output to 1000 lines maximum
  const lines = r.split("\n");
  if (lines.length > 1000) {
    r = lines.slice(0, 1000).join("\n");
    r += `\n\n[Output truncated to 1000 lines]`;
  }

  return r;
}
