/**
 * Integration tests for oclif ralph task list command
 * Note: --help output goes through oclif's own routing
 */
import { describe, it, expect } from 'bun:test'
import { runCommand } from '@oclif/test'

describe('ralph task list command', () => {
  it('runs task list without error', async () => {
    // Runs against ralph-state.json in cwd - just verify no crash
    const { error } = await runCommand(['ralph:task:list'])
    expect(error).toBeUndefined()
  })

  it('supports --format flag', async () => {
    const { error } = await runCommand(['ralph:task:list', '--format', 'markdown'])
    expect(error).toBeUndefined()
  })
})
