import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import * as commentJson from 'comment-json'

const USER_SETTINGS_DIR = path.join(homedir(), '.config', 'towles-tool')
const USER_SETTINGS_PATH = path.join(USER_SETTINGS_DIR, 'towles-tool.settings.json')

interface JournalSettings {
  baseFolder: string
  dailyPathTemplate: string
  meetingPathTemplate: string
  notePathTemplate: string
}

interface UserSettings {
  preferredEditor: string
  journalSettings: JournalSettings
}

// Default settings fallback
export const DEFAULT_JOURNAL_SETTINGS: JournalSettings = {
  baseFolder: path.join(homedir(), 'Documents', 'journals'),
  dailyPathTemplate: '{yyyy}/{monday:yyyy-MM-dd}.md',
  meetingPathTemplate: 'meetings/{yyyy}/{yyyy-MM-dd}-{title}.md',
  notePathTemplate: 'notes/{yyyy}/{yyyy-MM-dd}-{title}.md',
}

/**
 * Load journal settings from user config file or return defaults
 */
export function loadJournalSettings(): JournalSettings {
  try {
    if (!existsSync(USER_SETTINGS_PATH)) {
      return DEFAULT_JOURNAL_SETTINGS
    }

    const content = readFileSync(USER_SETTINGS_PATH, 'utf-8')
    const config = commentJson.parse(content) as unknown as UserSettings

    if (config.journalSettings) {
      return {
        baseFolder: config.journalSettings.baseFolder || DEFAULT_JOURNAL_SETTINGS.baseFolder,
        dailyPathTemplate: config.journalSettings.dailyPathTemplate || DEFAULT_JOURNAL_SETTINGS.dailyPathTemplate,
        meetingPathTemplate: config.journalSettings.meetingPathTemplate || DEFAULT_JOURNAL_SETTINGS.meetingPathTemplate,
        notePathTemplate: config.journalSettings.notePathTemplate || DEFAULT_JOURNAL_SETTINGS.notePathTemplate,
      }
    }

    return DEFAULT_JOURNAL_SETTINGS
  }
  catch {
    // If any error reading/parsing config, fall back to defaults
    return DEFAULT_JOURNAL_SETTINGS
  }
}
