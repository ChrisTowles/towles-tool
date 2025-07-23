import type { Context } from '../config/context'
import consola from 'consola'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eatCommand } from './eat'

vi.mock('consola')

const mockConsola = vi.mocked(consola)

describe('eat command', () => {
  const mockContext: Context = {
    settingsFile: {
      settings: {
        journalSettings: {
          dailyPathTemplate: "/test/journal/{yyyy}/{MM}/daily-notes/{yyyy}-{MM}-{dd}-daily-notes.md",
          meetingPathTemplate: "/test/journal/{yyyy}/{MM}/meetings/{yyyy}-{MM}-{dd}-{title}.md",
          notePathTemplate: "/test/journal/{yyyy}/notes/{MM}/notes/{yyyy}-{MM}-{dd}-{title}.md"
        },
        preferredEditor: 'code',
      },
      path: '/test/settings.json',
    },
    cwd: '/test',
    args: [],
    debug: false,
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should display puppy art and jokes', async () => {
    await eatCommand(mockContext)

    // Check that puppy intro was displayed
    expect(mockConsola.info).toHaveBeenCalledWith('🐶 Here\'s a cute puppy for you!')
    
    // Check that puppy art was displayed
    expect(mockConsola.log).toHaveBeenCalledWith(expect.stringContaining('/^-----^\\'))
    
    // Check that jokes intro was displayed
    expect(mockConsola.info).toHaveBeenCalledWith('🎭 And here are five jokes to brighten your day:')
    
    // Check that jokes were displayed (should be 5 success calls for jokes)
    expect(mockConsola.success).toHaveBeenCalledTimes(5)
    expect(mockConsola.success).toHaveBeenCalledWith(expect.stringMatching(/^\d+\. .+/))
    
    // Check that closing message was displayed
    expect(mockConsola.info).toHaveBeenCalledWith('Hope that made you smile! 😊')
  })

  it('should handle errors gracefully', async () => {
    // Mock consola.info to throw an error
    mockConsola.info.mockImplementationOnce(() => {
      throw new Error('Test error')
    })

    // Mock process.exit to prevent the test from actually exiting
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })

    try {
      await eatCommand(mockContext)
    } catch (error) {
      expect(error).toEqual(new Error('process.exit called'))
    }

    expect(mockConsola.error).toHaveBeenCalledWith('Eat command failed:', 'Test error')
    expect(mockExit).toHaveBeenCalledWith(1)

    mockExit.mockRestore()
  })
})