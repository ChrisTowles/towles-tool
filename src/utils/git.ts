// unJs/changelogen has some nice utilities for git
import { execCommand } from './exec'

// using logic from https://github.com/unjs/changelogen/blob/main/src/git.ts

export async function getGitDiff(from: string | undefined, to = 'HEAD', cwd?: string): Promise<string> {
  // https://git-scm.com/docs/pretty-formats
  const r = execCommand(
    `git --no-pager log "${from ? `${from}...` : ''}${to}" --pretty="----%n%s|%h|%an|%ae%n%b" --name-status`,
    cwd,
  )

  return r
}
