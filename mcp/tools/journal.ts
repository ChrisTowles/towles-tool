import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  createJournalContent,
  createMeetingContent,
  createNoteContent,
  generateJournalFileInfoByType,
} from '../../src/commands/journal.js'
import { JOURNAL_TYPES } from '../../src/utils/parseArgs.js'
import type { JournalType } from '../../src/utils/parseArgs.js'

// Default settings - will be enhanced to load from config later
const DEFAULT_JOURNAL_SETTINGS = {
  baseFolder: path.join(process.env.HOME || process.env.USERPROFILE || '', 'Documents', 'journals'),
  dailyPathTemplate: '{yyyy}/{monday:yyyy-MM-dd}.md',
  meetingPathTemplate: 'meetings/{yyyy}/{yyyy-MM-dd}-{title}.md',
  notePathTemplate: 'notes/{yyyy}/{yyyy-MM-dd}-{title}.md',
}

interface JournalCreateArgs {
  type: JournalType
  title?: string
}

/**
 * Register journal-related tools with the MCP server
 */
export function registerJournalTools(server: Server): void {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    if (name === 'journal_create') {
      return handleJournalCreate(args as unknown as JournalCreateArgs)
    }

    // Let other handlers deal with other tools
    return {
      content: [
        {
          type: 'text',
          text: `Unknown tool: ${name}`,
        },
      ],
    }
  })
}

/**
 * Handle journal creation
 */
async function handleJournalCreate(args: JournalCreateArgs) {
  try {
    const { type, title = '' } = args

    // Validate type
    if (!['daily', 'meeting', 'note'].includes(type)) {
      throw new Error(`Invalid journal type: ${type}. Must be one of: daily, meeting, note`)
    }

    // Validate title for meeting and note types
    if ((type === JOURNAL_TYPES.MEETING || type === JOURNAL_TYPES.NOTE) && !title) {
      throw new Error(`Title is required for ${type} journal entries`)
    }

    const currentDate = new Date()
    const fileInfo = generateJournalFileInfoByType({
      journalSettings: DEFAULT_JOURNAL_SETTINGS,
      date: currentDate,
      type: type as JournalType,
      title: title,
    })

    // Ensure journal directory exists
    const dirPath = path.dirname(fileInfo.fullPath)
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true })
    }

    let isNew = false
    if (!existsSync(fileInfo.fullPath)) {
      isNew = true
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

      writeFileSync(fileInfo.fullPath, content, 'utf8')
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            action: isNew ? 'created' : 'exists',
            type,
            title: title || undefined,
            path: fileInfo.fullPath,
            message: isNew
              ? `Created new ${type} journal entry at: ${fileInfo.fullPath}`
              : `Journal entry already exists at: ${fileInfo.fullPath}`,
          }, null, 2),
        },
      ],
    }
  }
  catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: errorMessage,
          }, null, 2),
        },
      ],
      isError: true,
    }
  }
}
