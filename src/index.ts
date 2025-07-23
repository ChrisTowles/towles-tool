#!/usr/bin/env node

import process from 'node:process'
import yargs from 'yargs'
import type { Argv } from 'yargs'
import { hideBin } from 'yargs/helpers'
import { version as packageVersion } from '../package.json'
import { gitCommitCommand } from './commands/git-commit.js'
import { createJournalFile, JOURNAL_TYPES } from './commands/journal.js'
import { loadTowlesToolContext } from './config/context.js'
import { AppInfo } from './constants'
import { configCommand } from './commands/config.js'
import consola from 'consola'
import { loadSettings } from './config/settings'


// Define TypeScript interfaces for better type safety
interface JournalArgs {
  title?: string
}

interface GitCommitArgs {
  message?: string[]
}

async function main() {
  // Load the configuration
  const settings = await loadSettings()
  const context = await loadTowlesToolContext({ cwd: process.cwd(), settingsFile: settings.settingsFile,
     debug: true // later can be set to false in production or when not debugging
     })


  consola.info(`Using configuration from ${settings.settingsFile.path}`)


  // TODO: move to config file
  // Create yargs parser with enhanced error handling
  const parser = yargs(hideBin(process.argv))
    .scriptName(AppInfo.toolName)
    .usage('Usage: $0 <command> [options]')
    .version(packageVersion)
    .demandCommand(1, 'You need at least one command')
    .recommendCommands()
    .strict()
    .help()
    .wrap(yargs().terminalWidth())

  // Journal command with subcommands
  parser.command(
    ['journal', 'j'],
    'quickly create md files from templates files like daily-notes, meeting, notes, etc.',
    (yargs: Argv) => {
      return yargs
        .command(
          ['daily-notes', 'today'], 
          'Weekly files with daily sections for ongoing work and notes',
          {},
          async () => {
            await createJournalFile({ context: context, type: JOURNAL_TYPES.DAILY_NOTES, title: '' })
          }
        )
        .command(
          ['meeting [title]', 'm'],
          'Structured meeting notes with agenda and action items',
          (yargs: Argv) => {
            return yargs.positional('title', {
              type: 'string',
              describe: 'Meeting title'
            })
          },
          async (argv: JournalArgs) => {
            await createJournalFile({ context: context, type: JOURNAL_TYPES.MEETING, title: argv.title || '' })
          }
        )
        .command(
          ['note [title]', 'n'],
          'General-purpose notes with structured sections',
          (yargs: Argv) => {
            return yargs.positional('title', {
              type: 'string',
              describe: 'Note title'
            })
          },
          async (argv: JournalArgs) => {
            await createJournalFile({ context: context, type: JOURNAL_TYPES.NOTE, title: argv.title  || '' })
          }
        )
        .demandCommand(1, 'You need to specify a journal subcommand')
        .help()
    },
    () => {
      // Parent command handler - shows help if no subcommand
      parser.showHelp()
    }
  )

  // Git commit command
  parser.command(
    ['git-commit [message...]', 'gc'],
    'Git commit command with optional message',
    (yargs: Argv) => {
      return yargs.positional('message', {
        type: 'string',
        array: true,
        describe: 'Commit message words'
      })
    },
    async (argv: GitCommitArgs) => {
      await gitCommitCommand(context, argv.message || [])
    }
  )

  // Config command
  parser.command(
    ['config', 'cfg'],
    'set or show configuration file.',
    {},
    async () => {
      await configCommand(context)
    }
  )

  // Parse and execute
  await parser.parse()
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

