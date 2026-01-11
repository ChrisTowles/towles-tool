import { Flags } from '@oclif/core'
import { exec } from 'tinyexec'
import consola from 'consola'
import { colors } from 'consola/utils'

import { BaseCommand } from '../commands/base.js'
import { isGithubCliInstalled } from '../utils/git/gh-cli-wrapper.js'

/**
 * Create a pull request from the current branch
 * Note: Uses tinyexec which is safe (execFile-based, no shell injection)
 */
export default class Pr extends BaseCommand {
  static override description = 'Create a pull request from the current branch'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> pr --draft',
    '<%= config.bin %> pr --base develop',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    draft: Flags.boolean({
      description: 'Create as draft PR',
      default: false,
    }),
    base: Flags.string({
      char: 'b',
      description: 'Base branch for the PR',
      default: 'main',
    }),
    yes: Flags.boolean({
      char: 'y',
      description: 'Skip confirmation prompt',
      default: false,
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Pr)

    // Check prerequisites
    const cliInstalled = await isGithubCliInstalled()
    if (!cliInstalled) {
      consola.error('GitHub CLI not installed')
      this.exit(1)
    }

    // Get current branch
    const branchResult = await exec('git', ['branch', '--show-current'])
    const currentBranch = branchResult.stdout.trim()

    if (!currentBranch) {
      consola.error('Not on a branch (detached HEAD?)')
      this.exit(1)
    }

    if (currentBranch === flags.base) {
      consola.error(`Already on base branch ${flags.base}`)
      this.exit(1)
    }

    consola.info(`Current branch: ${colors.cyan(currentBranch)}`)
    consola.info(`Base branch: ${colors.cyan(flags.base)}`)

    // Get commits between base and current branch
    const logResult = await exec('git', [
      'log',
      `${flags.base}..HEAD`,
      '--pretty=format:%s',
    ])

    const commits = logResult.stdout.trim().split('\n').filter(Boolean)

    if (commits.length === 0) {
      consola.error(`No commits between ${flags.base} and ${currentBranch}`)
      this.exit(1)
    }

    consola.info(`Found ${colors.green(commits.length.toString())} commits`)

    // Generate PR title and body
    const { title, body } = this.generatePrContent(currentBranch, commits)

    consola.box({
      title: 'PR Preview',
      message: `Title: ${title}\n\n${body}`,
    })

    // Confirm unless --yes
    if (!flags.yes) {
      const confirmed = await consola.prompt('Create this PR?', {
        type: 'confirm',
        initial: true,
      })

      if (!confirmed) {
        consola.info(colors.dim('Canceled'))
        this.exit(0)
      }
    }

    // Push branch if needed
    const statusResult = await exec('git', ['status', '-sb'])
    const needsPush = !statusResult.stdout.includes('origin/')

    if (needsPush) {
      consola.info('Pushing branch to remote...')
      await exec('git', ['push', '-u', 'origin', currentBranch])
    }

    // Create PR
    const prArgs = [
      'pr', 'create',
      '--title', title,
      '--body', body,
      '--base', flags.base,
    ]

    if (flags.draft) {
      prArgs.push('--draft')
    }

    const prResult = await exec('gh', prArgs)
    const prUrl = prResult.stdout.trim()

    consola.success(`PR created: ${colors.cyan(prUrl)}`)
  }

  private generatePrContent(branch: string, commits: string[]): { title: string; body: string } {
    // Extract issue number from branch name if present (e.g., feature/123-some-feature)
    const issueMatch = branch.match(/(\d+)/)
    const issueNumber = issueMatch ? issueMatch[1] : null

    // Generate title from first commit or branch name
    let title: string
    if (commits.length === 1) {
      title = commits[0]
    } else {
      // Use branch name, cleaned up
      title = branch
        .replace(/^(feature|fix|bugfix|hotfix|chore|refactor)\//, '')
        .replace(/^\d+-/, '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
    }

    // Generate body
    const lines: string[] = ['## Summary', '']

    if (commits.length === 1) {
      lines.push(`- ${commits[0]}`)
    } else {
      for (const commit of commits.slice(0, 10)) {
        lines.push(`- ${commit}`)
      }
      if (commits.length > 10) {
        lines.push(`- ... and ${commits.length - 10} more commits`)
      }
    }

    lines.push('')

    if (issueNumber) {
      lines.push(`Closes #${issueNumber}`)
      lines.push('')
    }

    lines.push('## Test plan')
    lines.push('')
    lines.push('- [ ] Tests pass')
    lines.push('- [ ] Manual testing')

    return { title, body: lines.join('\n') }
  }
}
