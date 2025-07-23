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

  it('should execute without errors', async () => {
    await expect(eatCommand(mockContext)).resolves.not.toThrow()
  })

  it('should log puppy info message', async () => {
    await eatCommand(mockContext)
    
    expect(mockConsola.info).toHaveBeenCalledWith('🐶 Here\'s your puppy!')
  })

  it('should log jokes info message', async () => {
    await eatCommand(mockContext)
    
    expect(mockConsola.info).toHaveBeenCalledWith('🎭 And here are five jokes to brighten your day:')
  })

  it('should log puppy ASCII art', async () => {
    await eatCommand(mockContext)
    
    expect(mockConsola.log).toHaveBeenCalledWith(expect.stringContaining('WOOF!'))
  })

  it('should log exactly five jokes', async () => {
    await eatCommand(mockContext)
    
    // Count the number of calls to consola.log that contain joke numbers (1. 2. 3. 4. 5.)
    const jokeCalls = mockConsola.log.mock.calls.filter(call => 
      call[0] && typeof call[0] === 'string' && /^\d+\.\s/.test(call[0])
    )
    
    expect(jokeCalls).toHaveLength(5)
  })

  it('should log success message', async () => {
    await eatCommand(mockContext)
    
    expect(mockConsola.success).toHaveBeenCalledWith('Hope that made you smile! 😊')
  })
})