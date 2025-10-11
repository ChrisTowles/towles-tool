import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  createJournalContent,
  createMeetingContent,
  createNoteContent,
  generateJournalFileInfoByType,
} from '../../src/commands/journal.js'
import { JOURNAL_TYPES } from '../../src/utils/parseArgs.js'
import type { JournalType } from '../../src/utils/parseArgs.js'
import { loadJournalSettings } from '../lib/load-settings.js'

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

    if (name === 'journal_list') {
      return handleJournalList(args as unknown as { count?: number, type?: string })
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
    const journalSettings = loadJournalSettings()

    const fileInfo = generateJournalFileInfoByType({
      journalSettings,
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

/**
 * Handle listing recent journal entries
 */
async function handleJournalList(args: { count?: number, type?: string }) {
  try {
    const count = args.count || 10
    const type = args.type || 'all'

    const journalSettings = loadJournalSettings()
    const baseFolder = journalSettings.baseFolder

    if (!existsSync(baseFolder)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              entries: [],
              message: `Journal base folder does not exist: ${baseFolder}`,
            }, null, 2),
          },
        ],
      }
    }

    // Recursively find all markdown files
    const files: Array<{ path: string, mtime: Date }> = []

    function findMarkdownFiles(dir: string) {
      try {
        const items = readdirSync(dir)

        for (const item of items) {
          const fullPath = path.join(dir, item)
          const stats = statSync(fullPath)

          if (stats.isDirectory()) {
            findMarkdownFiles(fullPath)
          }
          else if (stats.isFile() && item.endsWith('.md')) {
            // Filter by type if specified
            if (type !== 'all') {
              if (type === 'daily' && !fullPath.includes('daily-notes'))
                continue
              if (type === 'meeting' && !fullPath.includes('meetings'))
                continue
              if (type === 'note' && !fullPath.includes('notes'))
                continue
            }

            files.push({
              path: fullPath,
              mtime: stats.mtime,
            })
          }
        }
      }
      catch {
        // Skip directories we can't read
      }
    }

    findMarkdownFiles(baseFolder)

    // Sort by modification time (newest first) and limit
    const recentFiles = files
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
      .slice(0, count)
      .map(f => ({
        path: f.path,
        relativePath: path.relative(baseFolder, f.path),
        modified: f.mtime.toISOString(),
      }))

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            count: recentFiles.length,
            entries: recentFiles,
            baseFolder,
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
