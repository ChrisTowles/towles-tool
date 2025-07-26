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
  jouralType: JournalType
}

export interface GitCommitArgs {
  message?: string 
}

export interface GitHubBranchArgs {
  assignedToMe?: boolean 
}


export interface ConfigArgs {
  // Config command has no specific args for now
}

// Union type for all possible parsed arguments
export type ParsedArgs = 
  | { command: 'journal'; args: JournalArgs }
  | { command: 'git-commit'; args: GitCommitArgs }
  | { command: 'gh-branch'; args: GitHubBranchArgs }
  | { command: 'config'; args: ConfigArgs }

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
            parsedResult = { command: 'journal', args: { jouralType: 'daily-notes', title: '' } }
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
            parsedResult = { command: 'journal', args: { jouralType: 'meeting', title: argv.title || '' } }
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
            parsedResult = { command: 'journal', args: { jouralType: 'note', title: argv.title || '' } }
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
    {
      message: {
        type: 'string',
        array: true,
        describe: 'Commit message words'
      }
    },
    (argv: any) => {
      parsedResult = { command: 'git-commit', args: { message: argv.message } }
    }
  )

  // Git commit command
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

  // Parse arguments
  await parser.parse()
  
  if (!parsedResult) {
    throw new Error('No command was parsed')
  }
  
  return parsedResult
}