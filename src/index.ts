#!/usr/bin/env node

import process from 'node:process'
import { Command } from 'commander'
import { todayCommand } from './commands/today.js'

const program = new Command()

program
  .name('towles-tool')
  .description('One off quality of life scripts that I use on a daily basis')
  .version('0.0.0')

program
  .command('hello')
  .description('Say hello to the world')
  .option('-n, --name <name>', 'name to greet', 'World')
  .action((options) => {
    process.stdout.write(`Hello, ${options.name}!\n`)
  })

program
  .command('today')
  .description('Create and open a weekly journal file based on Monday of current week')
  .action(async () => {
    await todayCommand()
  })

program.parse()

export const one = 1
export const two = 2
