#!/usr/bin/env bun

import { Errors } from '@oclif/core'
import commands from '../src/oclif-commands/index.js'
import pjson from '../package.json'

// Direct command execution for Bun compiled binaries
// oclif's dynamic loading doesn't work with bundled executables

const args = process.argv.slice(2)

// Map command name to class (handle space-separated topics -> colon format)
function findCommand(args: string[]): { cmd: typeof commands[keyof typeof commands] | null; cmdArgs: string[] } {
  // Try progressively longer command prefixes
  for (let i = args.length; i > 0; i--) {
    const cmdName = args.slice(0, i).join(':')
    const cmd = commands[cmdName as keyof typeof commands]
    if (cmd) {
      return { cmd, cmdArgs: args.slice(i) }
    }
  }
  return { cmd: null, cmdArgs: args }
}

const { cmd, cmdArgs } = findCommand(args)

// Handle --help for main command list
if (!cmd || cmdArgs.includes('--help') || cmdArgs.includes('-h')) {
  if (!cmd) {
    // Show available commands
    console.log('Usage: tt <command> [options]\n')
    console.log('Commands:')
    for (const name of Object.keys(commands).sort()) {
      const CmdClass = commands[name as keyof typeof commands]
      console.log(`  ${name.replace(/:/g, ' ').padEnd(25)} ${CmdClass.description || ''}`)
    }
    process.exit(args.length === 0 || args[0] === '--help' || args[0] === '-h' ? 0 : 1)
  }

  // Show help for specific command
  const CmdClass = cmd
  console.log(`Usage: tt ${args.slice(0, args.length - cmdArgs.length).join(' ')} [OPTIONS]\n`)
  console.log(CmdClass.description || '')

  if (CmdClass.examples?.length) {
    console.log('\nExamples:')
    for (const ex of CmdClass.examples) {
      console.log(`  ${ex.replace(/<%= config.bin %>/g, 'tt')}`)
    }
  }

  const allFlags = { ...CmdClass.baseFlags, ...CmdClass.flags }
  if (Object.keys(allFlags).length > 0) {
    console.log('\nFlags:')
    for (const [name, flag] of Object.entries(allFlags)) {
      const char = (flag as any).char ? `-${(flag as any).char}, ` : '    '
      const desc = (flag as any).description || ''
      const def = (flag as any).default !== undefined ? ` (default: ${(flag as any).default})` : ''
      console.log(`  ${char}--${name.padEnd(20)} ${desc}${def}`)
    }
  }
  process.exit(0)
}

// Disable plugin loading and command discovery for compiled binaries
// We handle command routing ourselves
const configOpts = {
  root: process.cwd(),
  pjson: {
    ...pjson,
    oclif: {
      ...pjson.oclif,
      // Disable command discovery - we route commands manually
      commands: undefined,
      topicSeparator: pjson.oclif.topicSeparator as ' ' | ':',
    },
  },
  devPlugins: false,
  userPlugins: false,
}

try {
  await cmd.run(cmdArgs, configOpts)
} catch (error) {
  if (error instanceof Errors.ExitError) {
    process.exit(error.oclif.exit)
  }
  throw error
}
