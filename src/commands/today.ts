import type { TowlesToolConfig } from '../config'
import { exec } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import process from 'node:process'
import { promisify } from 'node:util'
import consola from 'consola'
import { colors } from 'consola/utils'
import { formatDate, getMondayOfWeek, getWeekInfo } from '../utils/date-utils'

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
 * Open file in default editor
 */
export async function openInEditor(filePath: string, config: TowlesToolConfig): Promise<void> {
  try {
    await execAsync(`"${config.editor}" "${filePath}"`)
  }
  catch (ex) {
    consola.warn(`Could not open in editor : '${config.editor}'. Modify your editor in the config: examples include 'code', 'code-insiders',  etc...`, ex)
  }
}

/**
 * Main today command implementation
 */
export async function todayCommand(config: TowlesToolConfig): Promise<void> {
  try {
    const fileInfo = generateJournalFileInfo()
    const filePath = path.join(config.journalDir!, ...fileInfo.pathPrefix, fileInfo.fileName)

    // Ensure journal directory exists
    ensureDirectoryExists(path.join(config.journalDir!, ...fileInfo.pathPrefix))

    if (!existsSync(filePath)) {
      const content = createJournalContent({ mondayDate: fileInfo.mondayDate })
      writeFileSync(filePath, content, 'utf8')
      consola.info(`Created new journal file: ${colors.cyan(filePath)}`)
    }
    else {
      consola.info(`Opening existing journal file: ${colors.cyan(filePath)}`)
    }

    await openInEditor(filePath, config)
  }
  catch (error) {
    consola.error('Error creating journal file:', error)
    process.exit(1)
  }
}

interface generateJournalFileResult {
  pathPrefix: string[]
  fileName: string
  mondayDate: Date
}
/**
 * Generate journal filename based on Monday of the current week
 * Format: YYYY-MM-DD-week.md (always uses Monday's date)
 */
export function generateJournalFileInfo(date: Date = new Date()): generateJournalFileResult {
  const monday = getMondayOfWeek(new Date(date))
  const fileName = `${formatDate(monday)}-week.md`
  const pathPrefix = [`${date.getFullYear()}`, 'journal']

  return { pathPrefix, fileName, mondayDate: monday }
}
