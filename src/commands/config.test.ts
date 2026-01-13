/**
 * Integration tests for oclif config command
 * Note: consola outputs to stderr with different log levels
 */
import { describe, it, expect } from 'bun:test'
import { runCommand } from '@oclif/test'

describe('config command', () => {
  it('runs config and outputs settings info', async () => {
    const { stderr } = await runCommand(['config'])
    // consola.warn outputs captured in stderr
    expect(stderr).toContain('User Config')
    expect(stderr).toContain('Working Directory')
  })

})
