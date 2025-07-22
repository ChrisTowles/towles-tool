import type { Context } from '../config/context.js'
import { renderApp } from '../App.js'

/**
 * Git commit command implementation with enhanced ink interface
 */
export async function gitCommitCommand(context: Context, messageArgs?: string[]): Promise<void> {
  const { waitUntilExit } = renderApp({
    context,
    command: 'git-commit',
    commandArgs: messageArgs
  })
  
  await waitUntilExit()
}