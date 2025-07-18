import type { Config } from '../config'
import process from 'node:process'
import consola from 'consola'
import { colors } from 'consola/utils'
import prompts from 'prompts'
import { execCommand } from '../utils/exec'

/**
 * Git commit command implementation
 */
export async function gitCommitCommand(config: Config, messageArgs?: string[]): Promise<void> {
  // Check git status first
  let statusOutput: string
  try {
    statusOutput = execCommand('git status --porcelain', config.cwd)
  } catch (error) {
    consola.error('Failed to get git status')
    process.exit(1)
  }

  const lines = statusOutput.trim().split('\n').filter(line => line.length > 0)
  const stagedFiles = lines.filter(line => line[0] !== ' ' && line[0] !== '?')
  const unstagedFiles = lines.filter(line => line[1] !== ' ' && line[1] !== '?')
  const untrackedFiles = lines.filter(line => line.startsWith('??'))

  // Display current status
  if (lines.length === 0) {
    consola.info('Working tree clean - nothing to commit')
    return
  }

  consola.info('Git status:')
  if (stagedFiles.length > 0) {
    consola.info(colors.green('Staged files:'))
    stagedFiles.forEach(file => consola.info(`  ${colors.green(file)}`))
  }
  if (unstagedFiles.length > 0) {
    consola.info(colors.yellow('Modified files (not staged):'))
    unstagedFiles.forEach(file => consola.info(`  ${colors.yellow(file)}`))
  }
  if (untrackedFiles.length > 0) {
    consola.info(colors.red('Untracked files:'))
    untrackedFiles.forEach(file => consola.info(`  ${colors.red(file)}`))
  }

  // If no staged files, ask if user wants to stage files
  if (stagedFiles.length === 0) {
    if (unstagedFiles.length > 0 || untrackedFiles.length > 0) {
      const { shouldStage } = await prompts({
        type: 'confirm',
        name: 'shouldStage',
        message: 'No files are staged. Would you like to add files first?',
        initial: true
      })

      if (shouldStage) {
        const { addAll } = await prompts({
          type: 'confirm',
          name: 'addAll',
          message: 'Add all modified and untracked files?',
          initial: true
        })

        if (addAll) {
          try {
            execCommand('git add .', config.cwd)
            consola.success('All files staged successfully')
          } catch (error) {
            consola.error('Failed to stage files')
            process.exit(1)
          }
        } else {
          consola.info(`Use ${colors.cyan('git add <file>...')} to stage specific files, then run the commit command again`)
          return
        }
      } else {
        consola.error(`No staged changes found to commit. Use ${colors.cyan('git add <file>...')} to stage changes before committing.`)
        process.exit(1)
      }
    } else {
      consola.error('No changes to commit')
      return
    }
  }

  // Get commit message
  let commitMessage: string

  if (messageArgs && messageArgs.length > 0) {
    // Join all arguments as the commit message
    commitMessage = messageArgs.join(' ')
  } else {
    // Prompt for commit message
    const { message } = await prompts({
      type: 'text',
      name: 'message',
      message: 'Enter commit message:',
      validate: (value: string) => value.trim().length > 0 || 'Commit message cannot be empty'
    })

    if (!message) {
      consola.info(colors.dim('Commit cancelled'))
      return
    }

    commitMessage = message.trim()
  }

  // Execute the commit
  const commandWithArgs = `git commit -m "${commitMessage.replace(/"/g, '\\"')}"`
  consola.info(`Running: ${colors.cyan(commandWithArgs)}`)

  try {
    execCommand(commandWithArgs, config.cwd)
    consola.success('Commit created successfully!')
  } catch (error) {
    consola.error('Failed to commit changes:')
    consola.error(error)
    process.exit(1)
  }
}