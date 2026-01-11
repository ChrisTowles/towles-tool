import type { Context } from '../config/context'
import { exec } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import consola from 'consola'
import { colors } from 'consola/utils'
import { formatDate, getMondayOfWeek, getWeekInfo } from '../utils/date-utils'
import { DateTime } from 'luxon'
import type { JournalSettings } from '../config/settings'
import { JOURNAL_TYPES } from '../types/journal'
import type { JournalArgs, JournalType } from '../types/journal'

// Default template file names
const TEMPLATE_FILES = {
  dailyNotes: 'daily-notes.md',
  meeting: 'meeting.md',
  note: 'note.md',
} as const

const execAsync = promisify(exec)

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
 * Load template from external file or return null if not found
 */
export function loadTemplate(templateDir: string, templateFile: string): string | null {
  const templatePath = path.join(templateDir, templateFile)
  if (existsSync(templatePath)) {
    return readFileSync(templatePath, 'utf8')
  }
  return null
}

/**
 * Get default template content for initial setup
 */
function getDefaultDailyNotesTemplate(): string {
  return `# Journal for Week {monday:yyyy-MM-dd}

## {monday:yyyy-MM-dd} Monday

## {tuesday:yyyy-MM-dd} Tuesday

## {wednesday:yyyy-MM-dd} Wednesday

## {thursday:yyyy-MM-dd} Thursday

## {friday:yyyy-MM-dd} Friday
`
}

function getDefaultMeetingTemplate(): string {
  return `# Meeting: {title}

**Date:** {date}
**Time:** {time}
**Attendees:**

## Agenda

-

## Notes

## Action Items

- [ ]

## Follow-up
`
}

function getDefaultNoteTemplate(): string {
  return `# {title}

**Created:** {date} {time}

## Summary

## Details

## References
`
}

/**
 * Initialize template directory with default templates (first run)
 */
export function ensureTemplatesExist(templateDir: string): void {
  ensureDirectoryExists(templateDir)

  const templates = [
    { file: TEMPLATE_FILES.dailyNotes, content: getDefaultDailyNotesTemplate() },
    { file: TEMPLATE_FILES.meeting, content: getDefaultMeetingTemplate() },
    { file: TEMPLATE_FILES.note, content: getDefaultNoteTemplate() },
  ]

  for (const { file, content } of templates) {
    const templatePath = path.join(templateDir, file)
    if (!existsSync(templatePath)) {
      writeFileSync(templatePath, content, 'utf8')
      consola.info(`Created default template: ${colors.cyan(templatePath)}`)
    }
  }
}

/**
 * Render template with variables
 */
function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (match, key) => {
    return vars[key] ?? match
  })
}

/**
 * Create initial journal content with date header
 */
export function createJournalContent({ mondayDate, templateDir }: { mondayDate: Date, templateDir?: string }): string {
  const weekInfo = getWeekInfo(mondayDate)

  // Try external template first
  if (templateDir) {
    const externalTemplate = loadTemplate(templateDir, TEMPLATE_FILES.dailyNotes)
    if (externalTemplate) {
      return renderTemplate(externalTemplate, {
        'monday:yyyy-MM-dd': formatDate(weekInfo.mondayDate),
        'tuesday:yyyy-MM-dd': formatDate(weekInfo.tuesdayDate),
        'wednesday:yyyy-MM-dd': formatDate(weekInfo.wednesdayDate),
        'thursday:yyyy-MM-dd': formatDate(weekInfo.thursdayDate),
        'friday:yyyy-MM-dd': formatDate(weekInfo.fridayDate),
      })
    }
  }

  // Fallback to hardcoded template
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
export function createMeetingContent({ title, date, templateDir }: { title?: string, date: Date, templateDir?: string }): string {
  const dateStr = formatDate(date)
  const timeStr = date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })
  const meetingTitle = title || 'Meeting'

  // Try external template first
  if (templateDir) {
    const externalTemplate = loadTemplate(templateDir, TEMPLATE_FILES.meeting)
    if (externalTemplate) {
      return renderTemplate(externalTemplate, {
        title: meetingTitle,
        date: dateStr,
        time: timeStr,
      })
    }
  }

  // Fallback to hardcoded template
  const content = [`# Meeting: ${meetingTitle}`]
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
export function createNoteContent({ title, date, templateDir }: { title?: string, date: Date, templateDir?: string }): string {
  const dateStr = formatDate(date)
  const timeStr = date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })
  const noteTitle = title || 'Note'

  // Try external template first
  if (templateDir) {
    const externalTemplate = loadTemplate(templateDir, TEMPLATE_FILES.note)
    if (externalTemplate) {
      return renderTemplate(externalTemplate, {
        title: noteTitle,
        date: dateStr,
        time: timeStr,
      })
    }
  }

  // Fallback to hardcoded template
  const content = [`# ${noteTitle}`]
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
 * Open file in default editor with folder context
 */
export async function openInEditor({ editor, filePath, folderPath }: { editor: string, filePath: string, folderPath?: string }): Promise<void> {
  try {
    if (folderPath) {
      // Open both folder and file - this works with VS Code and similar editors
      // the purpose is to open the folder context for better navigation
      await execAsync(`"${editor}" "${folderPath}" "${filePath}"`)
    } else {
      await execAsync(`"${editor}" "${filePath}"`)
    }
  }
  catch (ex) {
    consola.warn(`Could not open in editor : '${editor}'. Modify your editor in the config: examples include 'code', 'code-insiders',  etc...`, ex)
  }
}

/**
 * Main journal command implementation
 */
export async function journalCommand(context: Context, args: JournalArgs): Promise<void> {
  try {
    const fileInfo = generateJournalFileInfoByType({ 
      type: args.journalType,
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

    await openInEditor({
      editor: context.settingsFile.settings.preferredEditor,
      filePath: fileInfo.fullPath,
      folderPath: context.settingsFile.settings.journalSettings.baseFolder
    })
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


export function resolvePathTemplate(template: string, title: string, date: Date, mondayDate: Date): string {
  const dateTime = DateTime.fromJSDate(date, { zone: 'utc' })
  
  // Replace Luxon format tokens wrapped in curly braces
  return template.replace(/\{([^}]+)\}/g, (match, token) => {
    try {

      if (token === 'title') {
        


        return title.toLowerCase().replace(/\s+/g, '-')
      }

      if (token.startsWith('monday:')) {
        const mondayToken = token.substring(7) // Remove 'monday:' prefix
        const mondayDateTime = DateTime.fromJSDate(mondayDate, { zone: 'utc' })
        return mondayDateTime.toFormat(mondayToken)
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
export function generateJournalFileInfoByType({ journalSettings, date = new Date(), type, title }: generateJournalFileParams ): generateJournalFileResult {
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
      throw new Error(`Unknown JournalType: ${type}`)
  }

  // Resolve the path template and extract directory structure
  const resolvedPath = resolvePathTemplate(templatePath, title, currentDate, mondayDate)

  // Join baseFolder with the resolved path
  const fullPath = path.join(journalSettings.baseFolder, resolvedPath)

  return {
    currentDate: currentDate, fullPath: fullPath,  mondayDate
   } satisfies generateJournalFileResult
}

/**
 * Create journal file for specific type
 */
export async function createJournalFile({ context, type, title }: { context: Context, type: JournalType, title: string }): Promise<void> {
  try {
    const journalSettings = context.settingsFile.settings.journalSettings
    const templateDir = journalSettings.templateDir

    // Ensure templates exist on first run
    ensureTemplatesExist(templateDir)

    // Prompt for title if empty and type requires it
    if (title.trim().length === 0 && (type === JOURNAL_TYPES.MEETING || type === JOURNAL_TYPES.NOTE)) {

      title = await consola.prompt(`Enter ${type} title:` , {
        type: "text",
      });

    }

    const currentDate = new Date()
    const fileInfo = generateJournalFileInfoByType({
      journalSettings,
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
          content = createJournalContent({ mondayDate: fileInfo.mondayDate, templateDir })
          break
        case JOURNAL_TYPES.MEETING:
          content = createMeetingContent({ title, date: currentDate, templateDir })
          break
        case JOURNAL_TYPES.NOTE:
          content = createNoteContent({ title, date: currentDate, templateDir })
          break
        default:
          throw new Error(`Unknown journal type: ${type}`)
      }
      consola.info(`Creating new ${type} file: ${colors.cyan(fileInfo.fullPath)}`)
      writeFileSync(fileInfo.fullPath, content, 'utf8')

    }

    await openInEditor({
      editor: context.settingsFile.settings.preferredEditor,
      filePath: fileInfo.fullPath,
      folderPath: journalSettings.baseFolder
    })
  }
  catch (error) {
    consola.warn(`Error creating ${type} file:`, error)
    process.exit(1)
  }
}
