#!/usr/bin/env node

import process from 'node:process'
import { loadTowlesToolContext } from './config/context.js'
import consola from 'consola'
import { loadSettings } from './config/settings.js'
import { parseArguments} from './utils/parseArgs.js'
import type { ParsedArgs } from './utils/parseArgs.js'
import { gitCommitCommand } from './commands/git-commit.js'
import { createJournalFile, JOURNAL_TYPES } from './commands/journal.js'
import type { JournalType } from './commands/journal.js'
import { configCommand } from './commands/config.js'
import { jokesCommand } from './commands/jokes.js'

async function executeCommand(parsedArgs: ParsedArgs, context: any): Promise<void> {
  switch (parsedArgs.command) {
    case 'journal': {
      const { subcommand, title } = parsedArgs.args
      let journalType: JournalType
      
      switch (subcommand) {
        case 'daily-notes':
        case 'today':
          journalType = JOURNAL_TYPES.DAILY_NOTES
          break
        case 'meeting':
          journalType = JOURNAL_TYPES.MEETING
          break
        case 'note':
          journalType = JOURNAL_TYPES.NOTE
          break
        default:
          throw new Error(`Unknown journal subcommand: ${subcommand}`)
      }
      
      await createJournalFile({ context, type: journalType, title: title || '' })
      break
    }
    
    case 'git-commit':
      await gitCommitCommand(context, parsedArgs.args.message)
      break
      
    case 'config':
      await configCommand(context)
      break
      
    case 'jokes':
      await jokesCommand(context)
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

