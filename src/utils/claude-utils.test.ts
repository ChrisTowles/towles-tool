import { describe, expect, it } from 'vitest'
import { invokeClaude } from './claude-utils'

describe('claude utilities', () => {
  it('invokeClaude should return a string', async () => {
    const result = await invokeClaude({ prompt: 'tell a joke' })
    expect(typeof result).toBe('string')
  }, 3_000)
})
