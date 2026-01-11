import { Args } from '@oclif/core'
import { BaseCommand } from '../../commands/base.js'
import { createJournalFile } from '../../commands/journal.js'
import { JOURNAL_TYPES } from '../../types/journal.js'

/**
 * Create or open general-purpose note file
 */
export default class Note extends BaseCommand {
  static override description = 'General-purpose notes with structured sections'

  static override aliases = ['journal:n']

  static override args = {
    title: Args.string({
      description: 'Note title',
      required: false,
    }),
  }

  static override examples = [
    '<%= config.bin %> journal note',
    '<%= config.bin %> journal note "Research Notes"',
    '<%= config.bin %> journal n "Ideas"',
  ]

  async run(): Promise<void> {
    const { args } = await this.parse(Note)

    await createJournalFile({
      context: {
        cwd: process.cwd(),
        settingsFile: this.settings.settingsFile,
        debug: false,
      },
      type: JOURNAL_TYPES.NOTE,
      title: args.title || '',
    })
  }
}
