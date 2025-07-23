import type { Context } from '../config/context'
import { exec } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import consola from 'consola'
import { colors } from 'consola/utils'
import { formatDate, getMondayOfWeek, getWeekInfo } from '../utils/date-utils'
import { DateTime } from 'luxon'
import type { JournalSettings } from '../config/settings'

const execAsync = promisify(exec)

export const JOURNAL_TYPES = {
  DAILY_NOTES: 'daily-notes',
  MEETING: 'meeting',
  NOTE: 'note',
} as const

type JournalType = typeof JOURNAL_TYPES[keyof typeof JOURNAL_TYPES]

/**
 * Create journal directory if it doesn't exist
 */
export function ensureDirectoryExists(folderPath: string): void {
  if (!existsSync(folderPath)) {
    consola.info(`Creating journal directory: ${colors.cyan(folderPath)}`)
    mkdirSync(folderPath, { recursive: true })
  }
}

/**
 * Create initial journal content with date header
 */
export function createJournalContent({ mondayDate }: { mondayDate: Date }): string {
  const weekInfo = getWeekInfo(mondayDate)



  // TODO: maybe put holidays in here?

  const content = [`# Journal for Week ${formatDate(mondayDate)}`]
  content.push(``)
  content.push(`## ${formatDate(weekInfo.mondayDate)} Monday`)
  content.push(``)
  content.push(`## ${formatDate(weekInfo.tuesdayDate)} Tuesday`)
  content.push(``)
  content.push(`## ${formatDate(weekInfo.wednesdayDate)} Wednesday`)
  content.push(``)
  content.push(`## ${formatDate(weekInfo.thursdayDate)} Thursday`)
  content.push(``)
  content.push(`## ${formatDate(weekInfo.fridayDate)} Friday`)
  content.push(``)

  return content.join('\n')
}

/**
 * Create meeting template content
 */
export function createMeetingContent({ title, date }: { title?: string, date: Date }): string {
  const dateStr = formatDate(date)
  const timeStr = date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })

  const content = [`# Meeting: ${title || 'Meeting'}`]
  content.push(``)
  content.push(`**Date:** ${dateStr}`)
  content.push(`**Time:** ${timeStr}`)
  content.push(`**Attendees:** `)
  content.push(``)
  content.push(`## Agenda`)
  content.push(``)
  content.push(`- `)
  content.push(``)
  content.push(`## Notes`)
  content.push(``)
  content.push(`## Action Items`)
  content.push(``)
  content.push(`- [ ] `)
  content.push(``)
  content.push(`## Follow-up`)
  content.push(``)

  return content.join('\n')
}

/**
 * Create note template content
 */
export function createNoteContent({ title, date }: { title?: string, date: Date }): string {
  const dateStr = formatDate(date)
  const timeStr = date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })

  const content = [`# ${title || 'Note'}`]
  content.push(``)
  content.push(`**Created:** ${dateStr} ${timeStr}`)
  content.push(``)
  content.push(`## Summary`)
  content.push(``)
  content.push(`## Details`)
  content.push(``)
  content.push(`## References`)
  content.push(``)

  return content.join('\n')
}

/**
 * Open file in default editor
 */
export async function openInEditor({ editor, filePath }: { editor: string, filePath: string }): Promise<void> {
  try {
    await execAsync(`"${editor}" "${filePath}"`)
  }
  catch (ex) {
    consola.warn(`Could not open in editor : '${editor}'. Modify your editor in the config: examples include 'code', 'code-insiders',  etc...`, ex)
  }
}

/**
 * Main journal command implementation
 */
export async function journalCommand(context: Context, journalType: JournalType = JOURNAL_TYPES.DAILY_NOTES): Promise<void> {
  try {
    const fileInfo = generateJournalFileInfoByType({ 
      type: journalType,
      date: new Date(),
      title: '', // Default title, can be modified later
      journalSettings: context.settingsFile.settings.journalSettings,
    })

    if(context.debug) {
      consola.info(`Debug mode: Journal file info:`, fileInfo)
    }
    // Ensure journal directory exists
    ensureDirectoryExists(path.dirname(fileInfo.fullPath))

    if (!existsSync(fileInfo.fullPath)) {
      const content = createJournalContent({ mondayDate: fileInfo.mondayDate })
      writeFileSync(fileInfo.fullPath, content, 'utf8')
      consola.info(`Created new journal file: ${colors.cyan(fileInfo.fullPath)}`)
    }
    else {
      consola.info(`Opening existing journal file: ${colors.cyan(fileInfo.fullPath)}`)
    }

    await openInEditor({ editor: context.settingsFile.settings.preferredEditor, filePath: fileInfo.fullPath })
  }
  catch (error) {
    consola.warn('Error creating journal file:', error)
    process.exit(1)
  }
}

interface generateJournalFileResult {
  fullPath: string
  mondayDate: Date
  currentDate: Date
}

interface generateJournalFileParams {
  date: Date
  type: JournalType
  title: string
  journalSettings: JournalSettings
}


export function resolvePathTemplate(template: string, title: string, date: Date): string {
  const dateTime = DateTime.fromJSDate(date, { zone: 'utc' })
  
  // Replace Luxon format tokens wrapped in curly braces
  return template.replace(/\{([^}]+)\}/g, (match, token) => {
    try {

      if (token === 'title') {
        return title.toLowerCase().replace(/\s+/g, '-')
      }
      const result = dateTime.toFormat(token)
      // Check if the result contains suspicious patterns that indicate invalid tokens
      // This is a heuristic to detect when Luxon produces garbage output for invalid tokens
      const isLikelyInvalid = token.includes('invalid') || 
                             result.length > 20 || // Very long results are likely garbage
                             (result.length > token.length * 2 && /\d{10,}/.test(result)) || // Contains very long numbers
                             result.includes('UTC')
                             
      if (isLikelyInvalid) {
        consola.warn(`Invalid date format token: ${token}`)
        return match
      }
      return result
    } catch (error) {
      consola.warn(`Invalid date format token: ${token}`)
      return match // Return original token if format is invalid
    }
  })
}


/**
 * Generate journal file info for different types using individual path templates
 */
export function generateJournalFileInfoByType({ journalSettings, date = new Date(), type = JOURNAL_TYPES.DAILY_NOTES, title }: generateJournalFileParams ): generateJournalFileResult {
  const currentDate = new Date(date)
  

  let templatePath: string = ""
  let mondayDate: Date = getMondayOfWeek(currentDate)

  switch (type) {
    case JOURNAL_TYPES.DAILY_NOTES: {
      const monday = getMondayOfWeek(currentDate)
      templatePath = journalSettings.dailyPathTemplate
      mondayDate = monday
      break
    }
    case JOURNAL_TYPES.MEETING: {
      
      templatePath = journalSettings.meetingPathTemplate
      mondayDate = currentDate
      break
    }
    case JOURNAL_TYPES.NOTE: {
      templatePath = journalSettings.notePathTemplate
      mondayDate = currentDate
      break
    }
    default:
      throw new Error(`Unknown journal type: ${type}`)
  }

  // Resolve the path template and extract directory structure
  const resolvedPath = resolvePathTemplate(templatePath, title, currentDate)

  return { 
    currentDate: currentDate, fullPath: resolvedPath,  mondayDate
   } satisfies generateJournalFileResult
}

/**
 * Create journal file for specific type
 */
export async function createJournalFile({ context, type, title }: { context: Context, type: JournalType, title: string }): Promise<void> {
  try {
    const currentDate = new Date()
    const fileInfo = generateJournalFileInfoByType({ 
      journalSettings: context.settingsFile.settings.journalSettings,
      date: currentDate, 
      type: type,
      title: title
    })

    // Ensure journal directory exists
    ensureDirectoryExists(path.dirname(fileInfo.fullPath))

    if (existsSync(fileInfo.fullPath)) {
      consola.info(`Opening existing ${type} file: ${colors.cyan(fileInfo.fullPath)}`)
    }
    else {
      let content: string
      switch (type) {
        case JOURNAL_TYPES.DAILY_NOTES:
          content = createJournalContent({ mondayDate: fileInfo.mondayDate })
          break
        case JOURNAL_TYPES.MEETING:
          content = createMeetingContent({ title, date: currentDate })
          break
        case JOURNAL_TYPES.NOTE:
          content = createNoteContent({ title, date: currentDate })
          break
        default:
          throw new Error(`Unknown journal type: ${type}`)
      }
      consola.info(`Creating new ${type} file: ${colors.cyan(fileInfo.fullPath)}`)
      writeFileSync(fileInfo.fullPath, content, 'utf8')
      
    }

    await openInEditor({ editor: context.settingsFile.settings.preferredEditor, filePath: fileInfo.fullPath })
  }
  catch (error) {
    consola.warn(`Error creating ${type} file:`, error)
    process.exit(1)
  }
}
