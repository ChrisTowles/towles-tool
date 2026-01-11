import { BaseCommand } from '../../commands/base.js'

/**
 * Display current observability configuration status
 */
export default class ObserveStatus extends BaseCommand {
  static override description = 'Display current observability configuration status'

  static override examples = ['<%= config.bin %> <%= command.id %>']

  async run(): Promise<void> {
    await this.parse(ObserveStatus)
    this.log('observe status - not yet implemented')
    this.log('Will show cleanupPeriodDays, hooks, OTEL env vars')
  }
}
