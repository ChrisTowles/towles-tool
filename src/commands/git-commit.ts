import type { TowlesToolConfig } from '../config'
import consola from 'consola'
import { invokeClaude } from '../utils/claude-utils'

/**
 * Git commit command implementation
 */
export async function gitCommitCommand(config: TowlesToolConfig): Promise<void> {
  const result = await invokeClaude({ config, prompt: 'tell a joke' })
  consola.info('Claude says:', result)
}
