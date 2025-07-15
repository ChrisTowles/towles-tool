// unJs/changelogen has some nice utilities for git
import { execCommand } from './exec'

// using logic from https://github.com/unjs/changelogen/blob/main/src/git.ts

export async function getGitDiff(cwd: string): Promise<string> {
  // https://git-scm.com/docs/pretty-formats
  const r = execCommand(
    // `git --no-pager log "${from ? `${from}...` : ''}${to}"  `,
    `git --no-pager diff --staged`,
    // --name-status
    // --pretty="----%n%s|%h|%an|%ae%n%b"
    cwd,
  )

  // printDebug('getGitDiff', r)

  return r
}
