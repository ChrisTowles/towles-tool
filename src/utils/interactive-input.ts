import readline from 'node:readline'
import process from 'node:process'
import consola from 'consola'
import { colors } from 'consola/utils'
import { execCommand } from './exec'
import type { Config } from '../config'
import { printDiffStatus } from '../commands/git-commit'

export interface HotkeyAction {
  key: string
  key_combination: string
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
        
        if (hotkeys.length > 0) {
          process.stdout.write(colors.dim('\n(Hotkeys: '))
          hotkeys.forEach((hotkey, index) => {
            if (index > 0) process.stdout.write(colors.dim(', '))
            process.stdout.write(colors.dim(`${hotkey.key_combination}: ${hotkey.description}`))
          })
          process.stdout.write(colors.dim(')\n'))
        }

        process.stdout.write(`\n${prompt} `)
        
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
        //process.stdout.write(key)
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
      key_combination: 'ctrl+a',
      description: 'Stage all files (git add .)',
      action: async (config: Config) => {
        try {
          execCommand('git add .', config.cwd)
          consola.success('All files staged successfully')
          printDiffStatus(config)
        } catch (error) {
          throw new Error(`Failed to stage files: ${error}`)
        }
      }
    },
    {
      key: '\u0012', // Ctrl+R
      key_combination: 'ctrl+r',
      description: 'Refresh git status',
      action: async (config: Config) => {
        try {
          printDiffStatus(config)
        } catch (error) {
          throw new Error(`Failed to refresh git status: ${error}`)
        }
      }
    }
  ]
}