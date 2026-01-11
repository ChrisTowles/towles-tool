import { BaseCommand } from '../../commands/base.js'

/**
 * Configure observability settings for Claude Code
 */
export default class ObserveSetup extends BaseCommand {
  static override description = 'Configure Claude Code observability settings'

  static override examples = ['<%= config.bin %> <%= command.id %>']

  async run(): Promise<void> {
    await this.parse(ObserveSetup)
    this.log('observe setup - not yet implemented')
    this.log('Will configure SubagentStop hook and show OTEL env setup')
  }
}
