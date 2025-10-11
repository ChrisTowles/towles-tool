import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { execSync } from 'node:child_process'

interface GitStatusArgs {
  cwd?: string
}

interface GitDiffArgs {
  cwd?: string
  staged?: boolean
}

interface GitCommitGenerateArgs {
  cwd?: string
  includeContext?: boolean
}

/**
 * Register git-related tools with the MCP server
 */
export function registerGitTools(server: Server): void {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    switch (name) {
      case 'git_status':
        return handleGitStatus(args as unknown as GitStatusArgs)
      case 'git_diff':
        return handleGitDiff(args as unknown as GitDiffArgs)
      case 'git_commit_generate':
        return handleGitCommitGenerate(args as unknown as GitCommitGenerateArgs)
      default:
        // Let other handlers deal with other tools
        return {
          content: [
            {
              type: 'text',
              text: `Unknown tool: ${name}`,
            },
          ],
        }
    }
  })
}

/**
 * Get git repository status
 */
async function handleGitStatus(args: GitStatusArgs) {
  try {
    const cwd = args.cwd || process.cwd()

    // Check if in git repository
    try {
      execSync('git rev-parse --git-dir', { cwd, stdio: 'pipe' })
    }
    catch {
      throw new Error('Not a git repository')
    }

    const output = execSync('git status --porcelain', { cwd, encoding: 'utf-8' })
    const lines = output.trim().split('\n').filter(line => line.trim())

    const staged: string[] = []
    const unstaged: string[] = []
    const untracked: string[] = []

    for (const line of lines) {
      const status = line.substring(0, 2)
      const file = line.substring(3)

      if (status[0] !== ' ' && status[0] !== '?') {
        staged.push(file)
      }
      if (status[1] !== ' ' && status[1] !== '?') {
        unstaged.push(file)
      }
      if (status === '??') {
        untracked.push(file)
      }
    }

    const isClean = staged.length === 0 && unstaged.length === 0 && untracked.length === 0

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            clean: isClean,
            staged: staged.length,
            unstaged: unstaged.length,
            untracked: untracked.length,
            files: {
              staged,
              unstaged,
              untracked,
            },
          }, null, 2),
        },
      ],
    }
  }
  catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: errorMessage,
          }, null, 2),
        },
      ],
      isError: true,
    }
  }
}

/**
 * Get git diff
 */
async function handleGitDiff(args: GitDiffArgs) {
  try {
    const cwd = args.cwd || process.cwd()
    const staged = args.staged ?? true

    // Check if in git repository
    try {
      execSync('git rev-parse --git-dir', { cwd, stdio: 'pipe' })
    }
    catch {
      throw new Error('Not a git repository')
    }

    const command = staged ? 'git diff --cached' : 'git diff'
    const diff = execSync(command, { cwd, encoding: 'utf-8' })

    if (!diff.trim()) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              diff: '',
              message: staged ? 'No staged changes' : 'No unstaged changes',
            }, null, 2),
          },
        ],
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            diff,
            staged,
          }, null, 2),
        },
      ],
    }
  }
  catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: errorMessage,
          }, null, 2),
        },
      ],
      isError: true,
    }
  }
}

/**
 * Generate commit message suggestion based on git diff
 */
async function handleGitCommitGenerate(args: GitCommitGenerateArgs) {
  try {
    const cwd = args.cwd || process.cwd()
    const includeContext = args.includeContext ?? true

    // Check if in git repository
    try {
      execSync('git rev-parse --git-dir', { cwd, stdio: 'pipe' })
    }
    catch {
      throw new Error('Not a git repository')
    }

    // Get staged diff
    const diff = execSync('git diff --cached', { cwd, encoding: 'utf-8' })

    if (!diff.trim()) {
      throw new Error('No staged changes to commit')
    }

    // Get file list
    const statusOutput = execSync('git status --porcelain', { cwd, encoding: 'utf-8' })
    const stagedFiles = statusOutput
      .split('\n')
      .filter(line => line.trim() && line[0] !== ' ' && line[0] !== '?')
      .map(line => line.substring(3))

    let contextInfo = ''
    if (includeContext) {
      try {
        // Get recent commits for context
        const recentCommits = execSync('git log --oneline -5', { cwd, encoding: 'utf-8' })
        contextInfo = `\n\nRecent commits:\n${recentCommits}`
      }
      catch {
        // Ignore if no commits yet
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            stagedFiles,
            diff,
            context: includeContext ? contextInfo : undefined,
            message: 'Use this diff to generate a conventional commit message. Consider:\n'
              + '- Type: feat, fix, docs, style, refactor, test, chore\n'
              + '- Scope: affected component/module\n'
              + '- Description: clear, concise summary\n'
              + '- Body: detailed explanation if needed\n'
              + '- Breaking changes: note if API changes',
          }, null, 2),
        },
      ],
    }
  }
  catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: errorMessage,
          }, null, 2),
        },
      ],
      isError: true,
    }
  }
}
