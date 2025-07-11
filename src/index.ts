#!/usr/bin/env node

import process from 'node:process'
import { Command } from 'commander'
import _consola from 'consola'

import { colors } from 'consola/utils'
import { version as packageVersion } from '../package.json'
import { gitCommitCommand } from './commands/git-commit.js'
import { todayCommand } from './commands/today.js'
import { loadTowlesToolConfig } from './config.js'
import { constants } from './constants'
import { printJson } from './utils/print-utils'

async function main() {
  const consola = _consola.withTag(constants.toolName)

  // Load configuration
  const configWrapper = await loadTowlesToolConfig({ cwd: process.cwd() })

  const program = new Command()

  program
    .name(constants.toolName)
    .description('One off quality of life scripts that I use on a daily basis')
    .version(packageVersion)

  program
    .command('today')
    .description('Create and open a weekly journal file based on Monday of current week')
    .action(async () => {
      await todayCommand(configWrapper.config)
    })

  program
    .command('git-commit')
    .alias('gc')
    .description('Git commit command')
    .action(async () => {
      await gitCommitCommand()
    })

  program
    .command('config')
    .description('set or show configuration file.')
    .action(async () => {
      consola.log(colors.green('Showing configuration...'))
      consola.log('Config File:', configWrapper.configFile)
      printJson(configWrapper.config)
    })

  program.parse()
}

// eslint-disable-next-line antfu/no-top-level-await
await main()
