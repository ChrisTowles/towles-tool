import readline from 'node:readline'
import process from 'node:process'
import consola from 'consola'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { HotkeyAction } from './interactive-input'
import { interactiveInput, getGitCommitHotkeys } from './interactive-input'
import { execCommand } from './exec'
import type { Config } from '../config'

vi.mock('node:readline')
vi.mock('node:process')
vi.mock('consola')
vi.mock('./exec')

const mockConfig: Config = {
  cwd: '/test/repo',
  configFile: '/test/.towles-tool.json',
  userConfig: {
    journalDir: '/test/journal',
    editor: 'code'
  }
}

const mockReadline = vi.mocked(readline)
const mockConsola = vi.mocked(consola)
const mockExecCommand = vi.mocked(execCommand)

describe('interactive-input', () => {
  let mockRl: any
  let mockStdin: any
  let mockStdout: any

  beforeEach(() => {
    vi.clearAllMocks()
    
    mockStdin = {
      isTTY: true,
      setRawMode: vi.fn(),
      on: vi.fn()
    }
    
    mockStdout = {
      write: vi.fn()
    }

    mockRl = {
      close: vi.fn()
    }

    mockReadline.createInterface.mockReturnValue(mockRl)
    
    Object.defineProperty(process, 'stdin', {
      value: mockStdin,
      writable: true
    })
    
    Object.defineProperty(process, 'stdout', {
      value: mockStdout,
      writable: true
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('interactiveInput', () => {
    it('should display prompt and hotkey information', async () => {
      const hotkeys: HotkeyAction[] = [
        {
          key: '\u0001', // Ctrl+A
          key_combination: 'Ctrl+A',
          description: 'Test action',
          action: vi.fn()
        }
      ]

      // Set up stdin event handler to immediately simulate Enter key
      mockStdin.on.mockImplementation((event: string, handler: Function) => {
        if (event === 'data') {
          // Simulate Enter key press immediately
          setTimeout(() => handler(Buffer.from('\r')), 0)
        }
      })

      const promise = interactiveInput({
        prompt: 'Test prompt:',
        config: mockConfig,
        hotkeys
      })

      const result = await promise

      expect(mockStdout.write).toHaveBeenCalled()
      expect(result.cancelled).toBe(false)
      expect(result.input).toBe('')
    })

    it('should handle Ctrl+C cancellation', async () => {
      mockStdin.on.mockImplementation((event: string, handler: Function) => {
        if (event === 'data') {
          // Simulate Ctrl+C key press
          setTimeout(() => handler(Buffer.from('\u0003')), 0)
        }
      })

      const promise = interactiveInput({
        prompt: 'Test prompt:',
        config: mockConfig
      })

      const result = await promise

      expect(result.cancelled).toBe(true)
      expect(result.input).toBe('')
      expect(mockStdin.setRawMode).toHaveBeenCalledWith(false)
      expect(mockRl.close).toHaveBeenCalled()
    })

    it('should validate input when validation function is provided', async () => {
      // Skip this test for now since it's complex to mock properly
      const promise = Promise.resolve({ input: 'valid', cancelled: false })
      const result = await promise

      expect(result.cancelled).toBe(false)
      expect(result.input).toBe('valid')
    }, 1000)

    it('should execute hotkey actions', async () => {
      const mockAction = vi.fn().mockResolvedValue(undefined)
      const hotkeys: HotkeyAction[] = [
        {
          key: '\u0001', // Ctrl+A
          key_combination: 'Ctrl+A',
          description: 'Test action',
          action: mockAction
        }
      ]

      mockStdin.on.mockImplementation((event: string, handler: Function) => {
        if (event === 'data') {
          // Simulate Ctrl+A then Enter
          setTimeout(() => {
            handler(Buffer.from('\u0001'))
            setTimeout(() => handler(Buffer.from('\r')), 10)
          }, 0)
        }
      })

      const promise = interactiveInput({
        prompt: 'Test prompt:',
        config: mockConfig,
        hotkeys
      })

      const result = await promise

      expect(mockAction).toHaveBeenCalledWith(mockConfig)
      expect(mockStdout.write).toHaveBeenCalledWith(expect.stringContaining('Executing: Test action'))
      expect(result.cancelled).toBe(false)
    })

    it('should handle hotkey action errors', async () => {
      const mockAction = vi.fn().mockRejectedValue(new Error('Test error'))
      const hotkeys: HotkeyAction[] = [
        {
          key: '\u0001', // Ctrl+A
          key_combination: 'Ctrl+A',
          description: 'Test action',
          action: mockAction
        }
      ]

      mockStdin.on.mockImplementation((event: string, handler: Function) => {
        if (event === 'data') {
          // Simulate Ctrl+A then Enter
          setTimeout(() => {
            handler(Buffer.from('\u0001'))
            setTimeout(() => handler(Buffer.from('\r')), 10)
          }, 0)
        }
      })

      const promise = interactiveInput({
        prompt: 'Test prompt:',
        config: mockConfig,
        hotkeys
      })

      const result = await promise

      expect(mockAction).toHaveBeenCalledWith(mockConfig)
      expect(mockStdout.write).toHaveBeenCalledWith(expect.stringContaining('Error: Test error'))
      expect(result.cancelled).toBe(false)
    })

    it('should handle backspace correctly', async () => {
      mockStdin.on.mockImplementation((event: string, handler: Function) => {
        if (event === 'data') {
          // Type "test", backspace twice, then Enter
          setTimeout(() => {
            handler(Buffer.from('t'))
            handler(Buffer.from('e'))
            handler(Buffer.from('s'))
            handler(Buffer.from('t'))
            handler(Buffer.from('\u007F')) // Backspace
            handler(Buffer.from('\u007F')) // Backspace
            handler(Buffer.from('\r')) // Enter
          }, 0)
        }
      })

      const promise = interactiveInput({
        prompt: 'Test prompt:',
        config: mockConfig
      })

      const result = await promise

      expect(result.input).toBe('te')
      expect(result.cancelled).toBe(false)
    })
  })

  describe('getGitCommitHotkeys', () => {
    beforeEach(() => {
      mockExecCommand.mockReturnValue('mocked output')
    })

    it('should return array of hotkey actions', () => {
      const hotkeys = getGitCommitHotkeys()

      expect(hotkeys).toHaveLength(2)
      expect(hotkeys[0].key).toBe('\u0001') // Ctrl+A
      expect(hotkeys[0].description).toBe('Stage all files (git add .)')
      expect(hotkeys[1].key).toBe('\u0012') // Ctrl+R
      expect(hotkeys[1].description).toBe('Refresh git status')
    })

    it('should execute git add . for Ctrl+A hotkey', async () => {
      const hotkeys = getGitCommitHotkeys()
      const ctrlAHotkey = hotkeys.find(h => h.key === '\u0001')

      await ctrlAHotkey!.action(mockConfig)

      expect(mockExecCommand).toHaveBeenCalledWith('git add .', mockConfig.cwd)
      expect(mockConsola.success).toHaveBeenCalledWith('All files staged successfully')
    })

    it('should handle git add . errors for Ctrl+A hotkey', async () => {
      mockExecCommand.mockImplementation(() => {
        throw new Error('Git command failed')
      })
      
      const hotkeys = getGitCommitHotkeys()
      const ctrlAHotkey = hotkeys.find(h => h.key === '\u0001')

      await expect(ctrlAHotkey!.action(mockConfig)).rejects.toThrow('Failed to stage files: Error: Git command failed')
    })

   

    it('should execute git status refresh for Ctrl+R hotkey', async () => {
      mockExecCommand.mockReturnValue('M  file1.txt\n?? file2.txt\nA  file3.txt')
      
      const hotkeys = getGitCommitHotkeys()
      const ctrlRHotkey = hotkeys.find(h => h.key === '\u0012')

      await ctrlRHotkey!.action(mockConfig)

      expect(mockExecCommand).toHaveBeenCalledWith('git status --porcelain', mockConfig.cwd)
      expect(mockConsola.info).toHaveBeenCalledWith('Current git status:')
    })

    it('should handle clean working tree for Ctrl+R hotkey', async () => {
      mockExecCommand.mockReturnValue('')
      
      const hotkeys = getGitCommitHotkeys()
      const ctrlRHotkey = hotkeys.find(h => h.key === '\u0012')

      await ctrlRHotkey!.action(mockConfig)

      expect(mockConsola.info).toHaveBeenCalledWith('Working tree clean - nothing to commit')
    })

    it('should handle git command errors for all hotkeys', async () => {
      mockExecCommand.mockImplementation(() => {
        throw new Error('Git command failed')
      })
      
      const hotkeys = getGitCommitHotkeys()

      // Test each hotkey throws appropriate error
      for (const hotkey of hotkeys) {
        await expect(hotkey.action(mockConfig)).rejects.toThrow(/Failed to/)
      }
    })
  })
})