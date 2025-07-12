import type { TowlesToolSettings } from '../config'

import { describe, expect, it } from 'vitest'

import { invokeClaude } from './claude-utils'

describe('claude utilities', () => {
  const mockConfig: TowlesToolSettings = {
    journalDir: '/test/journal',
    editor: 'code',
  }

  it('invokeClaude should return a string', async () => {
    const result = await invokeClaude({ config: mockConfig, prompt: 'tell a joke' })
    expect(typeof result).toBe('string')
  })
})
