import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { Args } from '@oclif/core'
import consola from 'consola'
import { colors } from 'consola/utils'
import { BaseCommand } from '../../commands/base.js'
import { JOURNAL_TYPES } from '../../types/journal.js'
import {
  createNoteContent,
  ensureDirectoryExists,
  ensureTemplatesExist,
  generateJournalFileInfoByType,
  openInEditor,
} from './utils.js'

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

    try {
      const journalSettings = this.settings.settingsFile.settings.journalSettings
      const templateDir = journalSettings.templateDir

      // Ensure templates exist on first run
      ensureTemplatesExist(templateDir)

      // Prompt for title if not provided
      let title = args.title || ''
      if (title.trim().length === 0) {
        title = await consola.prompt(`Enter note title:`, {
          type: "text",
        })
      }

      const currentDate = new Date()
      const fileInfo = generateJournalFileInfoByType({
        journalSettings,
        date: currentDate,
        type: JOURNAL_TYPES.NOTE,
        title
      })

      // Ensure journal directory exists
      ensureDirectoryExists(path.dirname(fileInfo.fullPath))

      if (existsSync(fileInfo.fullPath)) {
        consola.info(`Opening existing note file: ${colors.cyan(fileInfo.fullPath)}`)
      }
      else {
        const content = createNoteContent({ title, date: currentDate, templateDir })
        consola.info(`Creating new note file: ${colors.cyan(fileInfo.fullPath)}`)
        writeFileSync(fileInfo.fullPath, content, 'utf8')
      }

      await openInEditor({
        editor: this.settings.settingsFile.settings.preferredEditor,
        filePath: fileInfo.fullPath,
        folderPath: journalSettings.baseFolder
      })
    }
    catch (error) {
      consola.warn(`Error creating note file:`, error)
      process.exit(1)
    }
  }
}
