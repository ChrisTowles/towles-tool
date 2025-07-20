import type { Config } from '../config.js'
import { renderApp } from '../App.js'

/**
 * Git commit command implementation with enhanced ink interface
 */
export async function gitCommitCommand(config: Config, messageArgs?: string[]): Promise<void> {
  const { waitUntilExit } = renderApp({
    config,
    command: 'git-commit',
    commandArgs: messageArgs
  })
  
  await waitUntilExit()
}