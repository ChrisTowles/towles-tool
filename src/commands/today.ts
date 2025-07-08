import { exec } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

import { generateJournalFilename } from '../utils/date.js'

const execAsync = promisify(exec)

/**
 * Default journal directory in user's home
 */
const DEFAULT_JOURNAL_DIR = join(homedir(), 'journal')

/**
 * Get the journal directory path
 */
export function getJournalDir(): string {
  return process.env.TOWLES_JOURNAL_DIR || DEFAULT_JOURNAL_DIR
}

/**
 * Create journal directory if it doesn't exist
 */
export function ensureJournalDir(): void {
  const journalDir = getJournalDir()
  if (!existsSync(journalDir)) {
    mkdirSync(journalDir, { recursive: true })
  }
}

/**
 * Create initial journal content with date header
 */
export function createJournalContent(filename: string): string {
  const date = new Date()
  const dateStr = date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  return `# Week of ${filename.replace('-week.md', '')}

## ${dateStr}

`
}

/**
 * Open file in default editor
 */
export async function openInEditor(filePath: string): Promise<void> {
  const editor = process.env.EDITOR || 'code'
  if (!editor) {
    console.error('No editor specified. Set EDITOR environment variable.')
    return
  }

  try {
    await execAsync(`"${editor}" "${filePath}"`)
  }
  catch (ex) {
    console.log('Could not open in editor. Set EDITOR environment variable or open manually.', ex)
  }
}

/**
 * Main today command implementation
 */
export async function todayCommand(): Promise<void> {
  try {
    ensureJournalDir()

    const filename = generateJournalFilename()
    const journalDir = getJournalDir()
    const filePath = join(journalDir, filename)

    if (!existsSync(filePath)) {
      const content = createJournalContent(filename)
      writeFileSync(filePath, content, 'utf8')
      console.log(`Created new journal file: ${filename}`)
    }
    else {
      console.log(`Opening existing journal file: ${filename}`)
    }

    await openInEditor(filePath)
  }
  catch (error) {
    console.error('Error creating journal file:', error)
    process.exit(1)
  }
}
