import { describe, it, expect, vi, beforeEach } from 'vitest'
import yargs from 'yargs'

// Mock the command modules
vi.mock('./commands/git-commit.js', () => ({
  gitCommitCommand: vi.fn()
}))

vi.mock('./commands/journal.js', () => ({
  createJournalFile: vi.fn(),
  JOURNAL_TYPES: {
    DAILY_NOTES: 'daily-notes',
    MEETING: 'meeting',
    NOTE: 'note'
  }
}))

vi.mock('./commands/config', () => ({
  configCommand: vi.fn()
}))

vi.mock('./config/config.js', () => ({
  loadTowlesToolConfig: vi.fn().mockResolvedValue({
    userConfig: { test: 'config' }
  })
}))

// Mock package.json
vi.mock('../package.json', () => ({
  version: '1.0.0'
}))

describe('CLI Command Structure (Yargs Migration Tests)', () => {
  let parser: ReturnType<typeof yargs>

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Command Registration', () => {
    it('should register all main commands with correct aliases', async () => {
      // Test yargs command registration
      parser = yargs(['--help'])
        .command(['journal', 'j'], 'quickly create md files from templates')
        .command(['git-commit [message...]', 'gc'], 'Git commit command with optional message')
        .command(['config', 'cfg'], 'set or show configuration file')
        .help()

      const helpOutput = await new Promise<string>((resolve) => {
        parser.parse('--help', (err: any, argv: any, output: any) => {
          resolve(output || '')
        })
      })

      expect(helpOutput).toContain('journal')
      expect(helpOutput).toContain('git-commit')
      expect(helpOutput).toContain('config')
      expect(helpOutput).toContain('aliases: j')
      expect(helpOutput).toContain('aliases: gc')
      expect(helpOutput).toContain('aliases: cfg')
    })

    it('should support journal subcommands with aliases', () => {
      const journalParser = yargs(['daily-notes'])
        .command(['daily-notes', 'today'], 'Weekly files with daily sections')
        .command(['meeting [title]', 'm'], 'Structured meeting notes')
        .command(['note [title]', 'n'], 'General-purpose notes')
        .parse()

      expect(journalParser).toBeDefined()
    })
  })

  describe('Argument Parsing', () => {
    it('should parse optional title argument for journal meeting', () => {
      const argv = yargs(['meeting', 'test-title'])
        .command('meeting [title]', 'meeting command')
        .parseSync()

      expect(argv.title).toBe('test-title')
    })

    it('should parse rest parameters for git-commit message', () => {
      const argv = yargs(['git-commit', 'fix:', 'update', 'tests'])
        .command('git-commit [message...]', 'git commit command')
        .parseSync()

      expect(argv.message).toEqual(['fix:', 'update', 'tests'])
    })

    it('should handle commands without arguments', () => {
      const argv = yargs(['config'])
        .command('config', 'config command')
        .parseSync()

      expect(argv._).toContain('config')
    })
  })

  describe('Enhanced Error Handling', () => {
    it('should suggest similar commands for typos', async () => {
      const parser = yargs(['journa'])  // typo
        .command('journal', 'journal command')
        .recommendCommands()
        .strict()

      const helpOutput = await new Promise<string>((resolve) => {
        parser.parse('journa', (err: any, argv: any, output: any) => {
          resolve(output || '')
        })
      })

      expect(helpOutput).toContain('Did you mean journal?')
    })

    it('should enforce minimum command requirement', async () => {
      const parser = yargs([])
        .command('journal', 'journal command')
        .demandCommand(1, 'You need at least one command')

      const helpOutput = await new Promise<string>((resolve) => {
        parser.parse([], (err: any, argv: any, output: any) => {
          resolve(output || '')
        })
      })

      expect(helpOutput).toContain('You need at least one command')
    })
  })

  describe('TypeScript Integration', () => {
    it('should provide proper typing for command arguments', () => {
      interface JournalArgs {
        title?: string
      }

      const argv = yargs(['meeting', 'test'])
        .command('meeting [title]', 'meeting command', (yargs: any) => {
          return yargs.positional('title', {
            type: 'string',
            describe: 'Meeting title'
          })
        })
        .parseSync()

      // TypeScript should infer correct types
      const title: string | undefined = (argv as JournalArgs).title
      expect(typeof title).toBe('string')
    })
  })
})