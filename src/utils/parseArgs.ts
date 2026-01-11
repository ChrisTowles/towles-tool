import process from 'node:process'
import yargs from 'yargs'
import type { Argv } from 'yargs'
import { hideBin } from 'yargs/helpers'
import { version as packageVersion } from '../../package.json'
import { AppInfo } from '../constants.js'

export const JOURNAL_TYPES = {
  DAILY_NOTES: 'daily-notes',
  MEETING: 'meeting',
  NOTE: 'note',
} as const

export type JournalType = typeof JOURNAL_TYPES[keyof typeof JOURNAL_TYPES]

// Define TypeScript interfaces for better type safety
export interface JournalArgs {
  title?: string
  journalType: JournalType
}

export interface GitHubBranchArgs {
  assignedToMe?: boolean 
}


export interface ConfigArgs {
  // Config command has no specific args for now
}

export interface RalphArgs {
  rawArgs: string[]
}

// Union type for all possible parsed arguments
export type ParsedArgs =
  | { command: 'journal'; args: JournalArgs }
  | { command: 'gh-branch'; args: GitHubBranchArgs }
  | { command: 'config'; args: ConfigArgs }
  | { command: 'ralph'; args: RalphArgs }

/**
 * Parse command line arguments and return parsed result
 */
export async function parseArguments(argv: string[]): Promise<ParsedArgs> {
  let parsedResult: ParsedArgs | null = null

  // Create yargs parser with enhanced error handling
  const parser = yargs(hideBin(argv))
    .scriptName(AppInfo.toolName)
    .usage('Usage: $0 <command> [options]')
    .version(packageVersion)
    .demandCommand(1, 'You need at least one command')
    .recommendCommands()
    .strict()
    .help()
    .wrap(yargs().terminalWidth())
    .showHelpOnFail(true)
    .completion('completion', 'Generate shell completion script')
    .fail((msg, err, yargs) => {
      if (msg) {
        yargs.showHelp()
        console.error('\n' + msg)
      }
      process.exit(0)
    })

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
          (argv) => {
            parsedResult = { command: 'journal', args: { journalType: 'daily-notes', title: '' } }
          }
        )
        .command(
          ['meeting [title]', 'm'],
          'Structured meeting notes with agenda and action items',
          {
            title: {
              type: 'string',
              describe: 'Meeting title'
            }
          },
          (argv: any) => {
            parsedResult = { command: 'journal', args: { journalType: 'meeting', title: argv.title || '' } }
          }
        )
        .command(
          ['note [title]', 'n'],
          'General-purpose notes with structured sections',
          {
            title: {
              type: 'string',
              describe: 'Note title'
            }
          },
          (argv: any) => {
            parsedResult = { command: 'journal', args: { journalType: 'note', title: argv.title || '' } }
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

  parser.command(
    ['gh-branch [assignedToMe...]', 'branch', 'br'],
    'Create git branch from github issue',
    {
      assignedToMe: {
        type: 'boolean',
        describe: 'filter issues based on if assigned to you by default',
        default: false
      }
    },
    (argv: any) => {
      parsedResult = { command: 'gh-branch', args: { assignedToMe: argv.assignedToMe } }
    }
  )

  // Config command
  parser.command(
    ['config', 'cfg'],
    'set or show configuration file.',
    {},
    () => {
      parsedResult = { command: 'config', args: {} }
    }
  )

  // Ralph command - autonomous Claude Code runner
  // Uses strict(false) to pass through args to citty
  parser.command(
    'ralph',
    'Run Claude Code in autonomous loop for task completion',
    (yargs) => yargs.strict(false).strictOptions(false).strictCommands(false),
    (argv: any) => {
      // Pass all args after 'ralph' to citty parser
      const ralphIndex = process.argv.indexOf('ralph')
      const rawArgs = ralphIndex >= 0 ? process.argv.slice(ralphIndex + 1) : []
      parsedResult = { command: 'ralph', args: { rawArgs } }
    }
  )

  // Parse arguments
  await parser.parse()
  
  if (!parsedResult) {
    throw new Error('No command was parsed')
  }
  
  return parsedResult
}