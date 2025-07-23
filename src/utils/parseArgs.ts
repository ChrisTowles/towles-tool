import yargs from 'yargs'
import type { Argv } from 'yargs'
import { hideBin } from 'yargs/helpers'
import { version as packageVersion } from '../../package.json'
import { AppInfo } from '../constants.js'

// Define TypeScript interfaces for better type safety
interface JournalArgs {
  title?: string
  subcommand: 'daily-notes' | 'today' | 'meeting' | 'note'
}

interface GitCommitArgs {
  message?: string 
}

interface ConfigArgs {
  // Config command has no specific args for now
}

interface JokesArgs {
  // Jokes command has no specific args for now
}

interface TylerJokesArgs {
  // Tyler jokes command has no specific args
}

// Union type for all possible parsed arguments
export type ParsedArgs = 
  | { command: 'journal'; args: JournalArgs }
  | { command: 'git-commit'; args: GitCommitArgs }
  | { command: 'config'; args: ConfigArgs }
  | { command: 'jokes'; args: JokesArgs }
  | { command: 'tyler-jokes'; args: TylerJokesArgs }

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
            parsedResult = { command: 'journal', args: { subcommand: 'daily-notes', title: '' } }
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
            parsedResult = { command: 'journal', args: { subcommand: 'meeting', title: argv.title || '' } }
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
            parsedResult = { command: 'journal', args: { subcommand: 'note', title: argv.title || '' } }
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

  // Config command
  parser.command(
    ['config', 'cfg'],
    'set or show configuration file.',
    {},
    () => {
      parsedResult = { command: 'config', args: {} }
    }
  )

  // Jokes command
  parser.command(
    'jokes',
    'Display 5 random programming jokes to brighten your day',
    {},
    () => {
      parsedResult = { command: 'jokes', args: {} }
    }
  )

  // Tyler jokes command
  parser.command(
    ['tyler-jokes', 'tj'],
    'Tell 5 jokes with "Tyler small" prompts between them.',
    {},
    () => {
      parsedResult = { command: 'tyler-jokes', args: {} }
    }
  )

  // Parse arguments
  await parser.parse()
  
  if (!parsedResult) {
    throw new Error('No command was parsed')
  }
  
  return parsedResult
}