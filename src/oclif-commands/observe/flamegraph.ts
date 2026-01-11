import { Flags } from '@oclif/core'
import { BaseCommand } from '../../commands/base.js'

/**
 * Generate Speedscope flamegraph from session data
 */
export default class ObserveFlamegraph extends BaseCommand {
  static override description = 'Generate Speedscope flamegraph from session token data'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --session abc123',
    '<%= config.bin %> <%= command.id %> --open',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    session: Flags.string({
      char: 's',
      description: 'Session ID to analyze (uses fzf for interactive selection if not provided)',
    }),
    open: Flags.boolean({
      char: 'o',
      description: 'Open Speedscope in browser after generating',
    }),
  }

  async run(): Promise<void> {
    await this.parse(ObserveFlamegraph)
    this.log('observe flamegraph - not yet implemented')
    this.log('Will parse JSONL and generate Speedscope JSON')
  }
}
