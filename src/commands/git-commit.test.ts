import process from 'node:process'
import consola from 'consola'
import prompts from 'prompts'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { gitCommitCommand } from './git-commit'
import { execCommand } from '../utils/exec'
import { interactiveInput, getGitCommitHotkeys } from '../utils/interactive-input'
import type { Config } from '../config'

vi.mock('node:process')
vi.mock('consola')
vi.mock('prompts')
vi.mock('../utils/exec')
vi.mock('../utils/interactive-input')

const mockConfig: Config = {
  cwd: '/test/repo',
  configFile: '/test/.towles-tool.json',
  userConfig: {
    journalDir: '/test/journal',
    editor: 'code'
  }
}

const mockConsola = vi.mocked(consola)
const mockPrompts = vi.mocked(prompts)
const mockExecCommand = vi.mocked(execCommand)
const mockInteractiveInput = vi.mocked(interactiveInput)
const mockGetGitCommitHotkeys = vi.mocked(getGitCommitHotkeys)

describe('git-commit command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetGitCommitHotkeys.mockReturnValue([])
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('gitCommitCommand', () => {
    it('should handle clean working tree', async () => {
      mockExecCommand.mockReturnValue('')

      await gitCommitCommand(mockConfig)

      expect(mockExecCommand).toHaveBeenCalledWith('git status --porcelain', mockConfig.cwd)
      expect(mockConsola.info).toHaveBeenCalledWith('Working tree clean - nothing to commit')
    })

    it('should display git status with color-coded files', async () => {
      mockExecCommand.mockReturnValue('M  staged.txt\n M unstaged.txt\n?? untracked.txt\nA  added.txt')

      // Mock the interactive input to return a commit message
      mockInteractiveInput.mockResolvedValue({ input: 'test commit', cancelled: false })

      await gitCommitCommand(mockConfig)

      expect(mockConsola.info).toHaveBeenCalledWith('Git status:')
      expect(mockConsola.info).toHaveBeenCalledWith(expect.stringContaining('Staged files:'))
      expect(mockConsola.info).toHaveBeenCalledWith(expect.stringContaining('Modified files (not staged):'))
      expect(mockConsola.info).toHaveBeenCalledWith(expect.stringContaining('Untracked files:'))
    })

    it('should handle git status failure', async () => {
      mockExecCommand.mockImplementation((command: string) => {
        if (command.includes('git status')) {
          throw new Error('Git status failed')
        }
        return ''
      })

      await gitCommitCommand(mockConfig)

      expect(mockConsola.error).toHaveBeenCalledWith('Failed to get git status')
      expect(process.exit).toHaveBeenCalledWith(1)
    })

    it('should commit with provided message arguments', async () => {
      mockExecCommand
        .mockReturnValueOnce('M  staged.txt') // git status
        .mockReturnValueOnce('') // git commit

      const messageArgs = ['fix:', 'resolve', 'authentication', 'bug']

      await gitCommitCommand(mockConfig, messageArgs)

      expect(mockExecCommand).toHaveBeenCalledWith(
        'git commit -m "fix: resolve authentication bug"',
        mockConfig.cwd
      )
      expect(mockConsola.success).toHaveBeenCalledWith('Commit created successfully!')
    })

    it('should handle commit message with quotes', async () => {
      mockExecCommand
        .mockReturnValueOnce('M  staged.txt') // git status
        .mockReturnValueOnce('') // git commit

      const messageArgs = ['fix: handle "quoted" strings properly']

      await gitCommitCommand(mockConfig, messageArgs)

      expect(mockExecCommand).toHaveBeenCalledWith(
        'git commit -m "fix: handle \\"quoted\\" strings properly"',
        mockConfig.cwd
      )
    })

    it('should remove extra quotes from message arguments', async () => {
      mockExecCommand
        .mockReturnValueOnce('M  staged.txt') // git status
        .mockReturnValueOnce('') // git commit

      const messageArgs = ['"fix: resolve bug"']

      await gitCommitCommand(mockConfig, messageArgs)

      expect(mockExecCommand).toHaveBeenCalledWith(
        'git commit -m "fix: resolve bug"',
        mockConfig.cwd
      )
    })

    it('should use interactive input for commit message when no args provided', async () => {
      mockExecCommand
        .mockReturnValueOnce('M  staged.txt') // git status
        .mockReturnValueOnce('') // git commit

      mockInteractiveInput.mockResolvedValue({ input: 'interactive commit message', cancelled: false })

      await gitCommitCommand(mockConfig)

      expect(mockInteractiveInput).toHaveBeenCalledWith({
        prompt: 'Enter commit message:',
        config: mockConfig,
        hotkeys: [],
        validate: expect.any(Function)
      })
      expect(mockExecCommand).toHaveBeenCalledWith(
        'git commit -m "interactive commit message"',
        mockConfig.cwd
      )
    })

    it('should validate commit message input', async () => {
      mockExecCommand.mockReturnValueOnce('M  staged.txt') // git status
      mockInteractiveInput.mockResolvedValue({ input: '', cancelled: false })

      await gitCommitCommand(mockConfig)

      // Get the validation function that was passed to interactiveInput
      const call = mockInteractiveInput.mock.calls[0][0]
      const validateFn = call.validate

      expect(validateFn!('')).toBe('Commit message cannot be empty')
      expect(validateFn!('   ')).toBe('Commit message cannot be empty')
      expect(validateFn!('valid message')).toBe(true)
    })

    it('should handle interactive input cancellation', async () => {
      mockExecCommand.mockReturnValueOnce('M  staged.txt') // git status
      mockInteractiveInput.mockResolvedValue({ input: '', cancelled: true })

      await gitCommitCommand(mockConfig)

      expect(mockConsola.info).toHaveBeenCalledWith(expect.stringContaining('Commit cancelled'))
      expect(mockExecCommand).not.toHaveBeenCalledWith(expect.stringContaining('git commit'), expect.any(String))
    })

    it('should handle empty interactive input', async () => {
      mockExecCommand.mockReturnValueOnce('M  staged.txt') // git status
      mockInteractiveInput.mockResolvedValue({ input: '', cancelled: false })

      await gitCommitCommand(mockConfig)

      expect(mockConsola.info).toHaveBeenCalledWith(expect.stringContaining('Commit cancelled'))
      expect(mockExecCommand).not.toHaveBeenCalledWith(expect.stringContaining('git commit'), expect.any(String))
    })

    it('should handle commit failure', async () => {
      mockExecCommand
        .mockReturnValueOnce('M  staged.txt') // git status
        .mockImplementationOnce(() => {
          throw new Error('Commit failed')
        }) // git commit

      mockInteractiveInput.mockResolvedValue({ input: 'test commit', cancelled: false })

      await gitCommitCommand(mockConfig)

      expect(mockConsola.error).toHaveBeenCalledWith('Failed to commit changes:')
      expect(mockConsola.error).toHaveBeenCalledWith(expect.any(Error))
      expect(process.exit).toHaveBeenCalledWith(1)
    })

    it('should prompt for staging when no staged files exist', async () => {
      mockExecCommand
        .mockReturnValueOnce(' M unstaged.txt\n?? untracked.txt') // git status - no staged files
        .mockReturnValueOnce('') // git add .
        .mockReturnValueOnce('') // git commit

      mockPrompts
        .mockResolvedValueOnce({ shouldStage: true }) // should stage files
        .mockResolvedValueOnce({ addAll: true }) // add all files

      mockInteractiveInput.mockResolvedValue({ input: 'test commit', cancelled: false })

      await gitCommitCommand(mockConfig)

      expect(mockPrompts).toHaveBeenCalledWith({
        type: 'confirm',
        name: 'shouldStage',
        message: 'No files are staged. Would you like to add files first?',
        initial: true
      })
      expect(mockPrompts).toHaveBeenCalledWith({
        type: 'confirm',
        name: 'addAll',
        message: 'Add all modified and untracked files?',
        initial: true
      })
      expect(mockExecCommand).toHaveBeenCalledWith('git add .', mockConfig.cwd)
      expect(mockConsola.success).toHaveBeenCalledWith('All files staged successfully')
    })

    it('should exit when user chooses not to stage files', async () => {
      mockExecCommand.mockReturnValueOnce(' M unstaged.txt') // git status - no staged files
      mockPrompts.mockResolvedValueOnce({ shouldStage: false })
      
      // Since process.exit is mocked, we need to mock it to actually throw to stop execution
      vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
        throw new Error(`Process exited with code ${code}`)
      }) as any)

      await expect(gitCommitCommand(mockConfig)).rejects.toThrow('Process exited with code 1')

      expect(mockConsola.error).toHaveBeenCalledWith(expect.stringContaining('No staged changes found to commit'))
    })

    it('should provide manual staging instruction when user chooses not to add all', async () => {
      mockExecCommand.mockReturnValueOnce(' M unstaged.txt') // git status - no staged files
      mockPrompts
        .mockResolvedValueOnce({ shouldStage: true })
        .mockResolvedValueOnce({ addAll: false })

      await gitCommitCommand(mockConfig)

      expect(mockConsola.info).toHaveBeenCalledWith(expect.stringContaining('git add <file>'))
    })

    it('should handle staging failure', async () => {
      mockExecCommand
        .mockReturnValueOnce(' M unstaged.txt') // git status - no staged files
        .mockImplementationOnce((command: string) => {
          if (command.includes('git add')) {
            throw new Error('Git add failed')
          }
          return ''
        })

      mockPrompts
        .mockResolvedValueOnce({ shouldStage: true })
        .mockResolvedValueOnce({ addAll: true })

      // Since process.exit is mocked, we need to mock it to actually throw to stop execution
      vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
        throw new Error(`Process exited with code ${code}`)
      }) as any)

      await expect(gitCommitCommand(mockConfig)).rejects.toThrow('Process exited with code 1')

      expect(mockConsola.error).toHaveBeenCalledWith('Failed to stage files')
    })

    it('should pass hotkeys to interactive input', async () => {
      const mockHotkeys = [
        { key: '\u0001', key_combination: 'Ctrl+A', description: 'Test hotkey', action: vi.fn() }
      ]
      mockGetGitCommitHotkeys.mockReturnValue(mockHotkeys)
      mockExecCommand.mockReturnValueOnce('M  staged.txt') // git status
      mockInteractiveInput.mockResolvedValue({ input: 'test commit', cancelled: false })

      await gitCommitCommand(mockConfig)

      expect(mockGetGitCommitHotkeys).toHaveBeenCalled()
      expect(mockInteractiveInput).toHaveBeenCalledWith({
        prompt: 'Enter commit message:',
        config: mockConfig,
        hotkeys: mockHotkeys,
        validate: expect.any(Function)
      })
    })
  })
})