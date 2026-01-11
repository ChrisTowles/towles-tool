import { BaseCommand } from '../../commands/base.js'
import { createJournalFile } from '../../commands/journal.js'
import { JOURNAL_TYPES } from '../../types/journal.js'

/**
 * Create or open daily notes journal file
 */
export default class DailyNotes extends BaseCommand {
  static override description = 'Weekly files with daily sections for ongoing work and notes'

  static override aliases = ['journal:today']

  static override examples = [
    '<%= config.bin %> journal daily-notes',
    '<%= config.bin %> journal today',
  ]

  async run(): Promise<void> {
    await this.parse(DailyNotes)

    await createJournalFile({
      context: {
        cwd: process.cwd(),
        settingsFile: this.settings.settingsFile,
        debug: false,
      },
      type: JOURNAL_TYPES.DAILY_NOTES,
      title: '',
    })
  }
}
