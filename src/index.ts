#!/usr/bin/env node

import process from 'node:process'
import { loadTowlesToolContext } from './config/context.js'
import consola from 'consola'
import { loadSettings } from './config/settings.js'
import { parseArguments} from './utils/parseArgs.js'
import type { ParsedArgs } from './utils/parseArgs.js'
import { createJournalFile } from './commands/journal.js'

import { configCommand } from './commands/config.js'
import { githubBranchCommand } from './commands/github-branch-command.js'
import { ralphCommand } from './commands/ralph.js'

async function executeCommand(parsedArgs: ParsedArgs, context: any): Promise<void> {
  switch (parsedArgs.command) {
    case 'journal': {
      await createJournalFile({ context, type: parsedArgs.args.journalType, title: parsedArgs.args.title || '' })
      break
    }
    case 'gh-branch':
      await githubBranchCommand(context, parsedArgs.args)
      break
    case 'config':
      await configCommand(context)
      break
    case 'ralph':
      await ralphCommand(parsedArgs.args.rawArgs)
      break

    default:
      throw new Error(`Unknown command: ${(parsedArgs as any).command}`)
  }
}

async function main() {
  // Load the configuration
  const settings = await loadSettings()
  const context = await loadTowlesToolContext({ 
    cwd: process.cwd(), 
    settingsFile: settings.settingsFile,
    debug: true // later can be set to false in production or when not debugging
  })

  consola.info(`Using configuration from ${settings.settingsFile.path}`)

  // Parse command line arguments
  const parsedArgs = await parseArguments(process.argv)
  
  // Execute the command
  await executeCommand(parsedArgs, context)
}

main().catch((error) => {
  consola.error('An unexpected critical error occurred:');
  if (error instanceof Error) {
    consola.error(error.stack);
  } else {
    consola.error(String(error));
  }
  process.exit(1);
});

