import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tylerJokesCommand } from './tyler-jokes'
import type { Context } from '../config/context'
import consola from 'consola'

// Mock the clack prompts
vi.mock('@clack/prompts', () => ({
  confirm: vi.fn().mockResolvedValue(true)
}))

// Mock consola
vi.mock('consola', () => ({
  default: {
    info: vi.fn(),
    box: vi.fn(),
    log: vi.fn(),
    success: vi.fn(),
    error: vi.fn()
  }
}))

describe('tyler-jokes command', () => {
  const mockContext: Context = {
    cwd: '/test',
    debug: false,
    args: [],
    settingsFile: {
      path: '/test/settings.json',
      settings: {
        preferredEditor: 'code',
        journalSettings: {
          dailyPathTemplate: './journal/{yyyy}/{MM-dd}-weekly.md',
          meetingPathTemplate: './journal/meetings/{yyyy}/{MM-dd}-{title}.md',
          notePathTemplate: './journal/notes/{yyyy}/{MM-dd}-{title}.md'
        }
      }
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should display welcome message', async () => {
    const { confirm } = await import('@clack/prompts')
    vi.mocked(confirm).mockResolvedValue(true)

    await tylerJokesCommand(mockContext)

    expect(consola.info).toHaveBeenCalledWith(
      expect.stringContaining('🎭 Welcome to Tyler Jokes!')
    )
  })

  it('should display all 5 jokes in boxes', async () => {
    const { confirm } = await import('@clack/prompts')
    vi.mocked(confirm).mockResolvedValue(true)

    await tylerJokesCommand(mockContext)

    // Should call consola.box 5 times (once for each joke)
    expect(consola.box).toHaveBeenCalledTimes(5)
    
    // Check that each joke box is called with the correct structure
    expect(consola.box).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Joke 1',
        style: expect.objectContaining({
          borderColor: 'cyan',
          borderStyle: 'round'
        })
      }),
      expect.stringContaining("Why don't scientists trust atoms?")
    )
  })

  it('should show "Tyler small" prompt 4 times (between jokes)', async () => {
    const { confirm } = await import('@clack/prompts')
    vi.mocked(confirm).mockResolvedValue(true)

    await tylerJokesCommand(mockContext)

    // Should call confirm 4 times (between the 5 jokes)
    expect(confirm).toHaveBeenCalledTimes(4)
    
    // Each confirm call should have "Tyler small" message
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Tyler small'),
        initialValue: true
      })
    )
  })

  it('should display success message at the end', async () => {
    const { confirm } = await import('@clack/prompts')
    vi.mocked(confirm).mockResolvedValue(true)

    await tylerJokesCommand(mockContext)

    expect(consola.success).toHaveBeenCalledWith(
      expect.stringContaining('🎉 All 5 jokes complete!')
    )
  })

  it('should handle errors and rethrow them', async () => {
    const { confirm } = await import('@clack/prompts')
    const testError = new Error('Test error')
    vi.mocked(confirm).mockRejectedValue(testError)

    await expect(tylerJokesCommand(mockContext)).rejects.toThrow('Test error')
    
    expect(consola.error).toHaveBeenCalledWith(
      'Error running Tyler jokes command:',
      testError
    )
  })

  it('should handle user cancellation gracefully', async () => {
    const { confirm } = await import('@clack/prompts')
    // Simulate user cancelling the prompt
    vi.mocked(confirm).mockResolvedValue(false)

    await tylerJokesCommand(mockContext)

    // Should still complete successfully even if user says no to prompts
    expect(consola.success).toHaveBeenCalledWith(
      expect.stringContaining('🎉 All 5 jokes complete!')
    )
  })
})