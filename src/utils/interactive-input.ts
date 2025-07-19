import readline from 'node:readline'
import process from 'node:process'
import consola from 'consola'
import { colors } from 'consola/utils'
import { execCommand } from './exec'
import type { Config } from '../config'

export interface HotkeyAction {
  key: string
  description: string
  action: (config: Config) => Promise<void> | void
}

export interface InteractiveInputOptions {
  prompt: string
  config: Config
  hotkeys?: HotkeyAction[]
  validate?: (input: string) => boolean | string
}

export interface InteractiveInputResult {
  input: string
  cancelled: boolean
}

/**
 * Creates an interactive input interface with hotkey support
 */
export async function interactiveInput(options: InteractiveInputOptions): Promise<InteractiveInputResult> {
  const { prompt, config, hotkeys = [], validate } = options
  
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    let currentInput = ''
    let inputInProgress = false

    // Set up raw mode to capture control keys
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
    }

    const displayPrompt = () => {
      if (!inputInProgress) {
        process.stdout.write(`\n${prompt} `)
        if (hotkeys.length > 0) {
          process.stdout.write(colors.dim('\n(Hotkeys: '))
          hotkeys.forEach((hotkey, index) => {
            if (index > 0) process.stdout.write(colors.dim(', '))
            process.stdout.write(colors.dim(`${hotkey.key}: ${hotkey.description}`))
          })
          process.stdout.write(colors.dim(')\n'))
          process.stdout.write(`${prompt} `)
        }
        process.stdout.write(currentInput)
      }
    }

    const cleanup = () => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false)
      }
      rl.close()
    }

    const handleInput = async (data: Buffer) => {
      const key = data.toString()
      
      // Handle control keys
      if (key === '\u0003') { // Ctrl+C
        cleanup()
        resolve({ input: '', cancelled: true })
        return
      }
      
      if (key === '\r' || key === '\n') { // Enter
        if (validate) {
          const validationResult = validate(currentInput.trim())
          if (validationResult !== true) {
            const errorMessage = typeof validationResult === 'string' ? validationResult : 'Invalid input'
            process.stdout.write(`\n${colors.red(errorMessage)}\n`)
            displayPrompt()
            return
          }
        }
        cleanup()
        resolve({ input: currentInput.trim(), cancelled: false })
        return
      }
      
      if (key === '\u007F' || key === '\b') { // Backspace
        if (currentInput.length > 0) {
          currentInput = currentInput.slice(0, -1)
          process.stdout.write('\b \b')
        }
        return
      }

      // Check for hotkeys
      let hotkeyMatched = false
      for (const hotkey of hotkeys) {
        if (key === hotkey.key) {
          hotkeyMatched = true
          inputInProgress = true
          process.stdout.write(`\n${colors.cyan(`Executing: ${hotkey.description}`)}\n`)
          
          try {
            await hotkey.action(config)
          } catch (error) {
            process.stdout.write(`${colors.red('Error:')} ${error}\n`)
          }
          
          inputInProgress = false
          displayPrompt()
          break
        }
      }
      
      if (!hotkeyMatched && key >= ' ' && key <= '~') { // Printable characters
        currentInput += key
        process.stdout.write(key)
      }
    }

    process.stdin.on('data', handleInput)
    displayPrompt()
  })
}

/**
 * Default hotkeys for git commit command
 */
export function getGitCommitHotkeys(): HotkeyAction[] {
  return [
    {
      key: '\u0001', // Ctrl+A
      description: 'Stage all files (git add .)',
      action: async (config: Config) => {
        try {
          execCommand('git add .', config.cwd)
          consola.success('All files staged successfully')
        } catch (error) {
          throw new Error(`Failed to stage files: ${error}`)
        }
      }
    },
    {
      key: '\u0013', // Ctrl+S
      description: 'Show git status',
      action: async (config: Config) => {
        try {
          const statusOutput = execCommand('git status --short', config.cwd)
          if (statusOutput.trim()) {
            consola.info('Git status:')
            consola.log(statusOutput)
          } else {
            consola.info('Working tree clean')
          }
        } catch (error) {
          throw new Error(`Failed to get git status: ${error}`)
        }
      }
    },
    {
      key: '\u0004', // Ctrl+D
      description: 'Show git diff (staged)',
      action: async (config: Config) => {
        try {
          const diffOutput = execCommand('git diff --cached', config.cwd)
          if (diffOutput.trim()) {
            consola.info('Staged changes:')
            consola.log(diffOutput)
          } else {
            consola.info('No staged changes to show')
          }
        } catch (error) {
          throw new Error(`Failed to get git diff: ${error}`)
        }
      }
    },
    {
      key: '\u0012', // Ctrl+R
      description: 'Refresh git status',
      action: async (config: Config) => {
        try {
          const statusOutput = execCommand('git status --porcelain', config.cwd)
          const lines = statusOutput.trim().split('\n').filter(line => line.length > 0)
          
          if (lines.length === 0) {
            consola.info('Working tree clean - nothing to commit')
            return
          }

          const stagedFiles = lines.filter(line => line[0] !== ' ' && line[0] !== '?')
          const unstagedFiles = lines.filter(line => line[1] !== ' ' && line[1] !== '?')
          const untrackedFiles = lines.filter(line => line.startsWith('??'))

          consola.info('Current git status:')
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
        } catch (error) {
          throw new Error(`Failed to refresh git status: ${error}`)
        }
      }
    }
  ]
}