import { createInterface } from 'node:readline'
import process from 'node:process'
import consola from 'consola'
import { colors } from 'consola/utils'
import { execCommand } from './exec'
import type { Config } from '../config'

export interface InteractiveInputOptions {
  prompt: string
  config: Config
  validate?: (value: string) => boolean | string
}

/**
 * Interactive input with hotkey support for git operations
 */
export async function getInteractiveInput(options: InteractiveInputOptions): Promise<string | null> {
  const { prompt, config, validate } = options
  
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    })

    let currentInput = ''
    
    // Display help text
    console.log(colors.dim('\nAvailable hotkeys:'))
    console.log(colors.dim('  Ctrl+A - Stage all files (git add .)'))
    console.log(colors.dim('  Ctrl+S - Show git status'))
    console.log(colors.dim('  Ctrl+D - Show git diff'))
    console.log(colors.dim('  Ctrl+R - Refresh git status'))
    console.log(colors.dim('  Ctrl+C - Cancel'))
    console.log('')
    
    process.stdout.write(`${prompt} `)
    
    // Enable raw mode to capture Ctrl combinations
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
    }
    
    const cleanup = () => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false)
      }
      rl.close()
    }
    
    process.stdin.on('data', (data) => {
      const key = data.toString()
      const byte = data[0]
      
      // Handle Ctrl combinations (ASCII control characters)
      if (byte === 1) { // Ctrl+A
        handleCtrlA(config, currentInput)
        return
      }
      
      if (byte === 19) { // Ctrl+S
        handleCtrlS(config, currentInput)
        return
      }
      
      if (byte === 4) { // Ctrl+D
        handleCtrlD(config, currentInput)
        return
      }
      
      if (byte === 18) { // Ctrl+R
        handleCtrlR(config, currentInput)
        return
      }
      
      if (byte === 3) { // Ctrl+C
        console.log(colors.dim('\nCommit cancelled'))
        cleanup()
        resolve(null)
        return
      }
      
      // Handle Enter
      if (byte === 13 || key === '\n') {
        console.log('') // New line
        
        if (validate) {
          const validationResult = validate(currentInput.trim())
          if (validationResult !== true) {
            const errorMessage = typeof validationResult === 'string' ? validationResult : 'Invalid input'
            consola.error(errorMessage)
            process.stdout.write(`${prompt} `)
            process.stdout.write(currentInput) // Restore current input
            return
          }
        }
        
        cleanup()
        resolve(currentInput.trim() || null)
        return
      }
      
      // Handle Backspace
      if (byte === 127 || byte === 8) {
        if (currentInput.length > 0) {
          currentInput = currentInput.slice(0, -1)
          process.stdout.write('\b \b') // Erase character
        }
        return
      }
      
      // Handle regular character input
      if (byte >= 32 && byte <= 126) { // Printable ASCII characters
        currentInput += key
        process.stdout.write(key)
      }
    })
  })
}

function handleCtrlA(config: Config, currentInput: string): void {
  console.log(colors.cyan('\n[Ctrl+A] Staging all files...'))
  
  try {
    execCommand('git add .', config.cwd)
    consola.success('All files staged successfully')
  } catch (error) {
    consola.error('Failed to stage files:', error)
  }
  
  // Restore prompt and current input
  process.stdout.write(`Enter commit message: ${currentInput}`)
}

function handleCtrlS(config: Config, currentInput: string): void {
  console.log(colors.cyan('\n[Ctrl+S] Current git status:'))
  
  try {
    const statusOutput = execCommand('git status --porcelain', config.cwd)
    displayGitStatus(statusOutput)
  } catch (error) {
    consola.error('Failed to get git status:', error)
  }
  
  // Restore prompt and current input
  process.stdout.write(`Enter commit message: ${currentInput}`)
}

function handleCtrlD(config: Config, currentInput: string): void {
  console.log(colors.cyan('\n[Ctrl+D] Git diff of staged changes:'))
  
  try {
    const diffOutput = execCommand('git diff --cached', config.cwd)
    if (diffOutput.trim()) {
      console.log(diffOutput)
    } else {
      console.log(colors.dim('No staged changes'))
    }
  } catch (error) {
    consola.error('Failed to get git diff:', error)
  }
  
  // Restore prompt and current input
  process.stdout.write(`Enter commit message: ${currentInput}`)
}

function handleCtrlR(config: Config, currentInput: string): void {
  console.log(colors.cyan('\n[Ctrl+R] Refreshing git status...'))
  
  try {
    const statusOutput = execCommand('git status --porcelain', config.cwd)
    displayGitStatus(statusOutput)
  } catch (error) {
    consola.error('Failed to refresh git status:', error)
  }
  
  // Restore prompt and current input
  process.stdout.write(`Enter commit message: ${currentInput}`)
}

function displayGitStatus(statusOutput: string): void {
  const lines = statusOutput.trim().split('\n').filter(line => line.length > 0)
  
  if (lines.length === 0) {
    consola.info('Working tree clean')
    return
  }
  
  const stagedFiles = lines.filter(line => line[0] !== ' ' && line[0] !== '?')
  const unstagedFiles = lines.filter(line => line[1] !== ' ' && line[1] !== '?')
  const untrackedFiles = lines.filter(line => line.startsWith('??'))
  
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
}