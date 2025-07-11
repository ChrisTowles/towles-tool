import type { TowlesToolConfig } from '../config'
import { homedir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { invokeClaude } from './claude-utils'

describe('claude utilities', () => {
  const mockConfig: TowlesToolConfig = {
    journalDir: '/test/journal',
    editor: 'code',
    claudeAlias: path.resolve(path.join(homedir(), '.claude/local/claude')),
  }

  it('invokeClaude should return a string', async () => {
    const result = await invokeClaude({ config: mockConfig, prompt: 'tell a joke' })
    expect(typeof result).toBe('string')
  })
})
