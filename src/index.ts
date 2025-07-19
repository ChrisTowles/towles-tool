#!/usr/bin/env node

import process from 'node:process'
import { Command } from 'commander'
import _consola from 'consola'

import { colors } from 'consola/utils'
import { version as packageVersion } from '../package.json'
import { gitCommitCommand } from './commands/git-commit.js'
import { createJournalFile, JOURNAL_TYPES } from './commands/journal.js'
import { loadTowlesToolConfig } from './config.js'
import { constants } from './constants'
import { printJson } from './utils/print-utils'

async function main() {
  const consola = _consola.withTag(constants.toolName)

  // Load configuration
  const config = await loadTowlesToolConfig({ cwd: process.cwd() })

  const program = new Command()

  program
    .name(constants.toolName)
    .description('One off quality of life scripts that I use on a daily basis')
    .version(packageVersion)

  // Journal command with sub commands
  const journalCmd = program
    .command('journal')
    .alias('j')
    .description('quickly create md files from templates files like daily-notes, meeting, notes, etc.')
    // .action(async () => {
    //   // await journalCommand(config.userConfig)
    // })

  journalCmd
    .command('daily-notes')
    .alias('today')
    .description('Weekly files with daily sections for ongoing work and notes')
    .action(async () => {
      await createJournalFile({ userConfig: config.userConfig, type: JOURNAL_TYPES.DAILY_NOTES })
    })

  journalCmd
    .command('meeting [title]')
    .alias('m')
    .description('Structured meeting notes with agenda and action items')
    .action(async (title?: string) => {
      await createJournalFile({ userConfig: config.userConfig, type: JOURNAL_TYPES.MEETING, title })
    })

  journalCmd
    .command('note [title]')
    .alias('n')
    .description('General-purpose notes with structured sections')
    .action(async (title?: string) => {
      await createJournalFile({ userConfig: config.userConfig, type: JOURNAL_TYPES.NOTE, title })
    })

  program
    .command('git-commit [message...]')
    .alias('gc')
    .description('Git commit command with optional message')
    .action(async (message: string[]) => {
      await gitCommitCommand(config, message)
    })

  program
    .command('config')
    .alias('cfg')
    .description('set or show configuration file.')
    .action(async () => {
      consola.log(colors.green('Showing configuration...'))
      consola.log('Settings File:', config.configFile)
      printJson(config)
    })

  program.parse()
}

// eslint-disable-next-line antfu/no-top-level-await
await main()
