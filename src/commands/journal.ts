import type { UserConfig } from '../config'
import { exec } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import consola from 'consola'
import { colors } from 'consola/utils'
import { formatDate, getMondayOfWeek, getWeekInfo } from '../utils/date-utils'

const execAsync = promisify(exec)

export const JOURNAL_TYPES = {
  DAILY_NOTES: 'daily-notes',
  MEETING: 'meeting',
  NOTE: 'note',
} as const

export type JournalType = typeof JOURNAL_TYPES[keyof typeof JOURNAL_TYPES]

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
export async function journalCommand(userConfig: UserConfig, journalType: JournalType = JOURNAL_TYPES.DAILY_NOTES): Promise<void> {
  try {
    const fileInfo = generateJournalFileInfo({ journalType })
    const filePath = path.join(userConfig.journalDir!, ...fileInfo.pathPrefix, fileInfo.fileName)

    // Ensure journal directory exists
    ensureDirectoryExists(path.join(userConfig.journalDir!, ...fileInfo.pathPrefix))

    if (!existsSync(filePath)) {
      const content = createJournalContent({ mondayDate: fileInfo.mondayDate })
      writeFileSync(filePath, content, 'utf8')
      consola.info(`Created new journal file: ${colors.cyan(filePath)}`)
    }
    else {
      consola.info(`Opening existing journal file: ${colors.cyan(filePath)}`)
    }

    await openInEditor({ editor: userConfig.editor, filePath })
  }
  catch (error) {
    consola.warn('Error creating journal file:', error)
    process.exit(1)
  }
}

interface generateJournalFileResult {
  pathPrefix: string[]
  fileName: string
  mondayDate: Date
}

interface generateJournalFileParams {
  date?: Date
  type?: JournalType
  title?: string
}

/**
 * Generate journal filename based on the type and Monday of the current week
 */
export function generateJournalFileInfo({ date = new Date(), journalType = JOURNAL_TYPES.DAILY_NOTES }: { date?: Date, journalType?: JournalType } = {}): generateJournalFileResult {
  const monday = getMondayOfWeek(new Date(date))

  const fileName = `${formatDate(monday)}-week-log.md`
  let pathPrefix = []
  switch (journalType) {
    case JOURNAL_TYPES.DAILY_NOTES:
      pathPrefix = [`${date.getFullYear()}`, 'daily-notes']
      break
    case JOURNAL_TYPES.MEETING:
      pathPrefix = [`${date.getFullYear()}`, 'meetings']
      break
    case JOURNAL_TYPES.NOTE:
      pathPrefix = [`${date.getFullYear()}`, 'notes']
      break
    default:
      throw new Error(`Unknown journal type: ${journalType}`)
  }

  return { pathPrefix, fileName, mondayDate: monday }
}

/**
 * Generate journal file info for different types
 */
export function generateJournalFileInfoByType({ date = new Date(), type = JOURNAL_TYPES.DAILY_NOTES, title }: generateJournalFileParams): generateJournalFileResult {
  const currentDate = new Date(date)
  const year = currentDate.getFullYear().toString()

  switch (type) {
    case JOURNAL_TYPES.DAILY_NOTES: {
      const monday = getMondayOfWeek(currentDate)
      const fileName = `${formatDate(monday)}-week-log.md`
      const pathPrefix = [year, 'daily-notes']
      return { pathPrefix, fileName, mondayDate: monday }
    }
    case JOURNAL_TYPES.MEETING: {
      const dateStr = formatDate(currentDate)
      const timeStr = currentDate.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }).replace(':', '')
      const titleSlug = title ? `-${title.toLowerCase().replace(/\s+/g, '-')}` : ''
      const fileName = `${dateStr}-${timeStr}-meeting${titleSlug}.md`
      const pathPrefix = [year, 'meetings']
      return { pathPrefix, fileName, mondayDate: currentDate }
    }
    case JOURNAL_TYPES.NOTE: {
      const dateStr = formatDate(currentDate)
      const timeStr = currentDate.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }).replace(':', '')
      const titleSlug = title ? `-${title.toLowerCase().replace(/\s+/g, '-')}` : ''
      const fileName = `${dateStr}-${timeStr}-note${titleSlug}.md`
      const pathPrefix = [year, 'notes']
      return { pathPrefix, fileName, mondayDate: currentDate }
    }
    default:
      throw new Error(`Unknown journal type: ${type}`)
  }
}

/**
 * Create journal file for specific type
 */
export async function createJournalFile({ userConfig, type, title }: { userConfig: UserConfig, type: JournalType, title?: string }): Promise<void> {
  try {
    const currentDate = new Date()
    const fileInfo = generateJournalFileInfoByType({ date: currentDate, type, title })
    const filePath = path.join(userConfig.journalDir!, ...fileInfo.pathPrefix, fileInfo.fileName)

    // Ensure journal directory exists
    ensureDirectoryExists(path.join(userConfig.journalDir!, ...fileInfo.pathPrefix))

    if (existsSync(filePath)) {
      consola.info(`Opening existing ${type} file: ${colors.cyan(filePath)}`)
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

      writeFileSync(filePath, content, 'utf8')
      consola.info(`Created new ${type} file: ${colors.cyan(filePath)}`)
    }

    await openInEditor({ editor: userConfig.editor, filePath })
  }
  catch (error) {
    consola.warn(`Error creating ${type} file:`, error)
    process.exit(1)
  }
}
