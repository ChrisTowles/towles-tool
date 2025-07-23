import consola from 'consola'
import prompts from 'prompts'
import type { Context } from '../config/context.js'
import { execCommand } from '../utils/exec.js'

/**
 * Git commit command implementation with consola interface
 */
export async function gitCommitCommand(context: Context, commitMessage: string | undefined): Promise<void> {
  try {
    // Get git status
    const status = await getGitStatus(context.cwd)
    
    if (!status || (status.staged.length === 0 && status.unstaged.length === 0 && status.untracked.length === 0)) {
      consola.success('✓ Working tree clean - nothing to commit')
      return
    }

    // Display current status
    displayGitStatus(status)

    // Handle staging if needed
    if (status.staged.length === 0) {
      const shouldStage = await prompts({
        type: 'confirm',
        name: 'stage',
        message: 'No files are staged. Add all modified and untracked files?',
        initial: true
      })

      if (!shouldStage.stage) {
        consola.info('Cancelled')
        return
      }

      consola.start('Staging files...')
      await execCommand('git add .', context.cwd)
      consola.success('Files staged')
    }

    // Get commit message
    if (!commitMessage) {
      const response = await prompts({
        type: 'text',
        name: 'message',
        message: 'Enter commit message:',
        validate: (value: string) => value.trim().length > 0 || 'Commit message cannot be empty'
      })

      if (!response.message) {
        consola.info('Cancelled')
        return
      }
      commitMessage = response.message
    }

    // Perform commit
    consola.start('Creating commit...')
    await execCommand(`git commit -m "${commitMessage}"`, context.cwd)
    consola.success('✓ Commit created successfully!')

  } catch (error) {
    consola.error('Git commit failed:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

async function getGitStatus(cwd: string) {
  try {
    const output = await execCommand('git status --porcelain',  cwd )
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

    return { staged, unstaged, untracked }
  } catch {
    return null
  }
}

function displayGitStatus(status: { staged: string[], unstaged: string[], untracked: string[] }) {
  consola.info('Current git status:')
  
  if (status.staged.length > 0) {
    consola.success(`✓ Staged files (${status.staged.length}):`)
    status.staged.slice(0, 5).forEach(file => consola.log(`  ${file}`))
    if (status.staged.length > 5) {
      consola.log(`  ... and ${status.staged.length - 5} more`)
    }
  }
  
  if (status.unstaged.length > 0) {
    consola.warn(`M Modified files (${status.unstaged.length}):`)
    status.unstaged.slice(0, 3).forEach(file => consola.log(`  ${file}`))
    if (status.unstaged.length > 3) {
      consola.log(`  ... and ${status.unstaged.length - 3} more`)
    }
  }
  
  if (status.untracked.length > 0) {
    consola.error(`? Untracked files (${status.untracked.length}):`)
    status.untracked.slice(0, 3).forEach(file => consola.log(`  ${file}`))
    if (status.untracked.length > 3) {
      consola.log(`  ... and ${status.untracked.length - 3} more`)
    }
  }
}