import { describe, it, expect, vi, beforeEach } from 'vitest'
import { jokesCommand, getRandomJokes, formatJokeOutput } from './jokes'
import type { Context } from '../config/context'
import consola from 'consola'

// Mock consola
vi.mock('consola', () => ({
  default: {
    log: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }
}))

describe('jokes command', () => {
  const mockContext: Context = {
    cwd: '/test',
    debug: false,
    args: [],
    settingsFile: {
      path: '/test/config.json',
      settings: {
        preferredEditor: 'code',
        journalSettings: {
          notePathTemplate: 'notes/{yyyy-MM-dd}-{title}.md',
          meetingPathTemplate: 'meetings/{yyyy-MM-dd}-{title}.md',
          dailyPathTemplate: 'daily/{yyyy-MM-dd}.md'
        }
      }
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getRandomJokes', () => {
    it('should return exactly 5 jokes', () => {
      const jokes = getRandomJokes()
      expect(jokes).toHaveLength(5)
    })

    it('should return different jokes on multiple calls', () => {
      // Set up deterministic random for testing
      const originalMath = Math.random
      let callCount = 0
      Math.random = vi.fn(() => {
        callCount++
        return callCount * 0.1 // Different values each call
      })

      const jokes1 = getRandomJokes()
      const jokes2 = getRandomJokes()
      
      // At least one joke should be different (due to shuffling)
      expect(jokes1).not.toEqual(jokes2)

      // Restore original Math.random
      Math.random = originalMath
    })

    it('should return valid joke strings', () => {
      const jokes = getRandomJokes()
      jokes.forEach(joke => {
        expect(typeof joke).toBe('string')
        expect(joke.length).toBeGreaterThan(0)
      })
    })
  })

  describe('formatJokeOutput', () => {
    const testJokes = [
      'Why do programmers prefer dark mode?',
      'How many programmers does it take?',
      'Why don\'t programmers like nature?'
    ]

    it('should format jokes with proper structure', () => {
      const output = formatJokeOutput(testJokes)
      
      expect(output).toContain('Tyler\'s Tech Joke Collection')
      expect(output).toContain('Here are 5 random programming jokes')
      expect(output).toContain('Hope these made you smile!')
    })

    it('should number the jokes correctly', () => {
      const output = formatJokeOutput(testJokes)
      
      expect(output).toContain('1.')
      expect(output).toContain('2.')
      expect(output).toContain('3.')
    })

    it('should include all provided jokes', () => {
      const output = formatJokeOutput(testJokes)
      
      testJokes.forEach(joke => {
        expect(output).toContain(joke)
      })
    })

    it('should handle empty joke array gracefully', () => {
      const output = formatJokeOutput([])
      
      expect(output).toContain('Tyler\'s Tech Joke Collection')
      expect(output).toContain('Hope these made you smile!')
    })
  })

  describe('jokesCommand', () => {
    it('should execute successfully and log formatted output', async () => {
      await jokesCommand(mockContext)
      
      expect(consola.log).toHaveBeenCalledTimes(1)
      const loggedOutput = vi.mocked(consola.log).mock.calls[0][0]
      expect(loggedOutput).toContain('Tyler\'s Tech Joke Collection')
    })

    it('should log debug info when debug mode is enabled', async () => {
      const debugContext = { ...mockContext, debug: true }
      
      await jokesCommand(debugContext)
      
      expect(consola.info).toHaveBeenCalledWith('Debug: Jokes command executed successfully')
    })

    it('should not log debug info when debug mode is disabled', async () => {
      await jokesCommand(mockContext)
      
      expect(consola.info).not.toHaveBeenCalled()
    })

    it('should handle errors gracefully', async () => {
      // Mock consola.log to throw an error
      vi.mocked(consola.log).mockImplementationOnce(() => {
        throw new Error('Mock error')
      })

      await expect(jokesCommand(mockContext)).rejects.toThrow('Mock error')
      expect(consola.error).toHaveBeenCalledWith('Error displaying jokes:', expect.any(Error))
    })
  })
})