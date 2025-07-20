#!/usr/bin/env node

import process from 'node:process'
import { version as packageVersion } from '../package.json'
import { loadTowlesToolConfig } from './config.js'
import { constants } from './constants'
import { renderApp } from './App.js'
import type { AppView } from './types.js'

function parseArgs() {
  const args = process.argv.slice(2)
  
  if (args.length === 0) {
    return { view: 'default' as AppView, commandArgs: [] }
  }

  const command = args[0]
  const commandArgs = args.slice(1)

  // Map command line arguments to views
  switch (command) {
    case 'journal':
    case 'j':
      return { view: 'journal' as AppView, commandArgs }
    case 'git-commit':
    case 'gc':
      return { view: 'git-commit' as AppView, commandArgs }
    case 'config':
    case 'cfg':
      return { view: 'config' as AppView, commandArgs }
    case 'chat':
    case 'c':
      return { view: 'chat' as AppView, commandArgs }
    case '--version':
    case '-v':
      // eslint-disable-next-line no-console
      console.log(packageVersion)
      process.exit(0)
      break
    case '--help':
    case '-h':
      // eslint-disable-next-line no-console
      console.log(`${constants.toolName} - One off quality of life scripts
      
Usage: ${constants.toolName} [command] [options]

Commands:
  journal, j     Create journal files (daily-notes, meeting, note)
  git-commit, gc Git commit with optional message
  config, cfg    Show or set configuration
  chat, c        Interactive chat mode
  
Options:
  --version, -v  Show version
  --help, -h     Show help`)
      process.exit(0)
      break
    default:
      return { view: 'default' as AppView, commandArgs: [command, ...commandArgs] }
  }
}

async function main() {
  const workspaceDir = process.cwd()
  const config = await loadTowlesToolConfig({ cwd: workspaceDir })
  const { view, commandArgs } = parseArgs()

  renderApp({
    config,
    command: view === 'default' ? undefined : view,
    commandArgs,
    initialView: view,
    initialArgs: commandArgs
  })
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('An unexpected critical error occurred:');
  if (error instanceof Error) {
    // eslint-disable-next-line no-console
    console.error(error.stack);
  } else {
    // eslint-disable-next-line no-console
    console.error(String(error));
  }
  process.exit(1);
});
