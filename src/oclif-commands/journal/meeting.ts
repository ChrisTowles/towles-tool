import { Args } from '@oclif/core'
import { BaseCommand } from '../../commands/base.js'
import { createJournalFile } from '../../commands/journal.js'
import { JOURNAL_TYPES } from '../../types/journal.js'

/**
 * Create or open meeting notes file
 */
export default class Meeting extends BaseCommand {
  static override description = 'Structured meeting notes with agenda and action items'

  static override aliases = ['journal:m']

  static override args = {
    title: Args.string({
      description: 'Meeting title',
      required: false,
    }),
  }

  static override examples = [
    '<%= config.bin %> journal meeting',
    '<%= config.bin %> journal meeting "Sprint Planning"',
    '<%= config.bin %> journal m "Standup"',
  ]

  async run(): Promise<void> {
    const { args } = await this.parse(Meeting)

    await createJournalFile({
      context: {
        cwd: process.cwd(),
        settingsFile: this.settings.settingsFile,
        debug: false,
      },
      type: JOURNAL_TYPES.MEETING,
      title: args.title || '',
    })
  }
}
