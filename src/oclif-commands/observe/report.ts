import { Flags } from '@oclif/core'
import { BaseCommand } from '../../commands/base.js'

/**
 * Generate token/cost usage report via ccusage
 */
export default class ObserveReport extends BaseCommand {
  static override description = 'Generate token/cost usage report via ccusage'

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --weekly',
    '<%= config.bin %> <%= command.id %> --output',
  ]

  static override flags = {
    ...BaseCommand.baseFlags,
    daily: Flags.boolean({
      description: 'Show daily breakdown (default)',
      exclusive: ['weekly', 'monthly'],
    }),
    weekly: Flags.boolean({
      description: 'Show weekly breakdown',
      exclusive: ['daily', 'monthly'],
    }),
    monthly: Flags.boolean({
      description: 'Show monthly breakdown',
      exclusive: ['daily', 'weekly'],
    }),
    output: Flags.boolean({
      char: 'o',
      description: 'Save report to ~/.claude/reports/',
    }),
  }

  async run(): Promise<void> {
    await this.parse(ObserveReport)
    this.log('observe report - not yet implemented')
    this.log('Will run ccusage and display token/cost breakdown')
  }
}
