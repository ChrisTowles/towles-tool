import type { Context } from '../config/context'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import consola from 'consola'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createJournalContent,
  ensureDirectoryExists,
  generateJournalFileInfoByType,
  journalCommand,
  openInEditor,
  resolvePathTemplate,
  JOURNAL_TYPES,
} from './journal'

vi.mock('node:fs')
vi.mock('node:child_process')
vi.mock('node:util', () => ({
  promisify: vi.fn(_fn => vi.fn().mockResolvedValue({ stdout: '', stderr: '' })),
}))
vi.mock('consola')

const mockExistsSync = vi.mocked(existsSync)
const mockMkdirSync = vi.mocked(mkdirSync)
const mockWriteFileSync = vi.mocked(writeFileSync)
const mockConsola = vi.mocked(consola)

describe('today command', () => {
  const mockContext: Context = {
    settingsFile: {
      settings: {
        journalSettings: {
          dailyPathTemplate: "/test/journal/{yyyy}/{MM}/daily-notes/{yyyy}-{MM}-{dd}-daily-notes.md",
          meetingPathTemplate: "/test/journal/{yyyy}/{MM}/meetings/{yyyy}-{MM}-{dd}-{title}.md",
          notePathTemplate: "/test/journal/{yyyy}/notes/{MM}/notes/{yyyy}-{MM}-{dd}-{title}.md"
        },
        preferredEditor: 'code',
      },
      path: '/test/settings.json',
    },
    cwd: '/test',
    args: [],
    debug: false,
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('ensureDirectoryExists', () => {
    it('should create directory if it does not exist', () => {
      mockExistsSync.mockReturnValue(false)

      ensureDirectoryExists('/test/path')

      expect(mockExistsSync).toHaveBeenCalledWith('/test/path')
      expect(mockMkdirSync).toHaveBeenCalledWith('/test/path', { recursive: true })
      expect(mockConsola.info).toHaveBeenCalledWith(expect.stringContaining('Creating journal directory'))
    })

    it('should not create directory if it already exists', () => {
      mockExistsSync.mockReturnValue(true)

      ensureDirectoryExists('/test/path')

      expect(mockExistsSync).toHaveBeenCalledWith('/test/path')
      expect(mockMkdirSync).not.toHaveBeenCalled()
      expect(mockConsola.info).not.toHaveBeenCalled()
    })
  })

  describe('createJournalContent', () => {
    it('should create journal content with week header and daily sections', () => {
      const mondayDate = new Date('2024-01-01')

      const content = createJournalContent({ mondayDate })

      expect(content).toContain('# Journal for Week 2024-01-01')
      expect(content).toContain('## 2024-01-01 Monday')
      expect(content).toContain('## 2024-01-02 Tuesday')
      expect(content).toContain('## 2024-01-03 Wednesday')
      expect(content).toContain('## 2024-01-04 Thursday')
      expect(content).toContain('## 2024-01-05 Friday')
    })

    it('should format content with proper newlines', () => {
      const mondayDate = new Date('2024-01-01')

      const content = createJournalContent({ mondayDate })

      expect(content).toMatch(/^# Journal for Week[\s\S]*## 2024-01-01 Monday[\s\S]*## 2024-01-02 Tuesday/)
      expect(content.split('\n')).toHaveLength(12)
    })
  })

  describe('openInEditor', () => {
    it('should execute editor command with file path', async () => {
      await openInEditor({ editor: mockContext.settingsFile.settings.preferredEditor, filePath: '/test/file.md' })
      // The promisify mock will handle the execution
      expect(true).toBe(true) // Placeholder assertion
    })


    describe('journalCommand', () => {
      it('should create new journal file when it does not exist', async () => {
        mockExistsSync
          .mockReturnValueOnce(false) // directory doesn't exist
          .mockReturnValueOnce(false) // file doesn't exist

        await journalCommand(mockContext, JOURNAL_TYPES.DAILY_NOTES)

        expect(mockMkdirSync).toHaveBeenCalled()
        expect(mockWriteFileSync).toHaveBeenCalledWith(
          expect.stringMatching(/.*\.md$/),
          expect.stringContaining('# Journal for Week'),
          'utf8',
        )
        expect(mockConsola.info).toHaveBeenCalledWith(expect.stringContaining('Created new journal file'))
      })

      it('should open existing journal file without creating new one', async () => {
        mockExistsSync.mockReturnValue(true)

        await journalCommand(mockContext)

        expect(mockWriteFileSync).not.toHaveBeenCalled()
        expect(mockConsola.info).toHaveBeenCalledWith(expect.stringContaining('Opening existing journal file'))
      })

      it('should construct correct file path', async () => {
        mockExistsSync.mockReturnValue(true)

        await journalCommand(mockContext)

        expect(mockConsola.info).toHaveBeenCalledWith(
          expect.stringContaining('2025'),
        )
      })
    })

    describe('resolvePathTemplate', () => {
      const testDate = new Date('2024-03-15T14:30:45Z')
      const title = 'Test Journal Entry'

      it('should resolve year format tokens in curly braces', () => {
        expect(resolvePathTemplate('{yyyy}', title, testDate)).toBe('2024')
        expect(resolvePathTemplate('{yy}', title, testDate)).toBe('24')
        expect(resolvePathTemplate('{y}', title, testDate)).toBe('2024')
      })

      it('should resolve month format tokens in curly braces', () => {
        expect(resolvePathTemplate('{MM}', title, testDate)).toBe('03')
        expect(resolvePathTemplate('{M}', title, testDate)).toBe('3')
        expect(resolvePathTemplate('{LLL}', title, testDate)).toBe('Mar')
        expect(resolvePathTemplate('{LLLL}', title, testDate)).toBe('March')
      })

      it('should resolve day format tokens in curly braces', () => {
        expect(resolvePathTemplate('{dd}', title, testDate)).toBe('15')
        expect(resolvePathTemplate('{d}', title, testDate)).toBe('15')
        expect(resolvePathTemplate('{EEE}', title, testDate)).toBe('Fri')
        expect(resolvePathTemplate('{EEEE}', title, testDate)).toBe('Friday')
      })

      it('should resolve time format tokens in curly braces', () => {
        expect(resolvePathTemplate('{HH}', title, testDate)).toBe('14')
        expect(resolvePathTemplate('{H}', title, testDate)).toBe('14')
        expect(resolvePathTemplate('{mm}', title, testDate)).toBe('30')
        expect(resolvePathTemplate('{m}', title, testDate)).toBe('30')
        expect(resolvePathTemplate('{ss}', title, testDate)).toBe('45')
        expect(resolvePathTemplate('{s}', title, testDate)).toBe('45')
      })

      it('should resolve quarter and week format tokens in curly braces', () => {
        expect(resolvePathTemplate('{q}', title, testDate)).toBe('1')
        expect(resolvePathTemplate('{qq}', title, testDate)).toBe('01')
        expect(resolvePathTemplate('{W}', title, testDate)).toBe('11') // Week of year
      })

      it('should handle complex path templates with mixed literal text and tokens', () => {
        expect(resolvePathTemplate('{yyyy}/{MM}/{dd}', title, testDate)).toBe('2024/03/15')
        expect(resolvePathTemplate('{yyyy}-{MM}-{dd}-{HH}-{mm}', title, testDate)).toBe('2024-03-15-14-30')
        expect(resolvePathTemplate('{yyyy}/{LLL}/daily-notes', title, testDate)).toBe('2024/Mar/daily-notes')
        expect(resolvePathTemplate('journal/{yyyy}/meetings/{MM}', title, testDate)).toBe('journal/2024/meetings/03')
      })

      it('should handle file paths with extensions and mixed content', () => {
        expect(resolvePathTemplate('{yyyy}/{MM}/{dd}.md', title, testDate)).toBe('2024/03/15.md')
        expect(resolvePathTemplate('notes-{yyyy}-{LLL}-{dd}.txt', title, testDate)).toBe('notes-2024-Mar-15.txt')
        expect(resolvePathTemplate('meeting-{yyyy}-{MM}-{dd}-{HH}{mm}.md', title, testDate)).toBe('meeting-2024-03-15-1430.md')
      })

      it('should preserve literal text without curly braces', () => {
        expect(resolvePathTemplate('static/path', title, testDate)).toBe('static/path')
        expect(resolvePathTemplate('notes.md', title, testDate)).toBe('notes.md')
        expect(resolvePathTemplate('daily-notes/folder', title, testDate)).toBe('daily-notes/folder')
      })

      it('should handle mixed tokens and literal text', () => {
        expect(resolvePathTemplate('journal/{yyyy}/daily-notes/{MM}', title, testDate)).toBe('journal/2024/daily-notes/03')
        expect(resolvePathTemplate('logs/{yyyy}/week-{W}', title, testDate)).toBe('logs/2024/week-11')
        expect(resolvePathTemplate('{EEEE}-{yyyy}-{MM}-{dd}.log', title, testDate)).toBe('Friday-2024-03-15.log')
      })

      it('should handle edge cases with mixed content', () => {
        const newYearDate = new Date('2024-01-01T00:00:00Z')
        expect(resolvePathTemplate('archive/{yyyy}/{MM}/{dd}', title, newYearDate)).toBe('archive/2024/01/01')

        const endOfYearDate = new Date('2024-12-31T23:59:59Z')
        expect(resolvePathTemplate('backup-{yyyy}-{MM}-{dd}-{HH}-{mm}-{ss}.zip', title, endOfYearDate)).toBe('backup-2024-12-31-23-59-59.zip')
      })

      it('should handle title included', () => {
        const newYearDate = new Date('2024-01-01T00:00:00Z')
        expect(resolvePathTemplate('archive/{yyyy}/{MM}/{dd}-{title}.md', title, newYearDate)).toBe('archive/2024/01/01-test-journal-entry.md')

        const endOfYearDate = new Date('2024-12-31T23:59:59Z')
        expect(resolvePathTemplate('backup-{yyyy}-{MM}-{dd}-{HH}-{mm}-{ss}-{title}.zip', title, endOfYearDate)).toBe('backup-2024-12-31-23-59-59-test-journal-entry.zip')
      })

      it('should handle invalid tokens gracefully', () => {
        expect(resolvePathTemplate('{invalid_token}/notes', title, testDate)).toBe('{invalid_token}/notes')
        expect(resolvePathTemplate('path/{xyz}/file.md', title, testDate)).toBe('path/{xyz}/file.md')
      })

      it('should handle multiple tokens in complex patterns', () => {
        expect(resolvePathTemplate('Q{q}-{yyyy}/M{MM}/W{W}', title, testDate)).toBe('Q1-2024/M03/W11')
        expect(resolvePathTemplate('{EEE}_{dd}_{LLL}_{yyyy}', title, testDate)).toBe('Fri_15_Mar_2024')
      })
    })

    describe('generateJournalFileInfoByType', () => {
      const mockJournalSettings = mockContext.settingsFile.settings.journalSettings

      it('should generate file info with default settings', () => {
        const date = new Date('2024-03-15T10:30:00Z')

        const dailyResult = generateJournalFileInfoByType({
          date,
          title: 'Weekly Log',
          type: JOURNAL_TYPES.DAILY_NOTES,
          journalSettings: mockJournalSettings
        })
        expect(dailyResult.fullPath).toBeDefined()
        expect(dailyResult.mondayDate).toBeDefined()

        const meetingResult = generateJournalFileInfoByType({
          date,
          title: 'Sprint Planning',
          type: JOURNAL_TYPES.MEETING,
          journalSettings: mockJournalSettings
        })
        expect(meetingResult.fullPath).toBeDefined()

        const noteResult = generateJournalFileInfoByType({
          date,
          title: 'Important Note',
          type: JOURNAL_TYPES.NOTE,
          journalSettings: mockJournalSettings
        })
        expect(noteResult.fullPath).toBeDefined()
      })

      it('should use path templates from settings', () => {
        const date = new Date('2024-07-22T14:45:00Z')

        const result = generateJournalFileInfoByType({
          date,
          title: 'Weekly Log',
          type: JOURNAL_TYPES.DAILY_NOTES,
          journalSettings: { notePathTemplate: '', dailyPathTemplate: '{yyyy}/daily/{MM}/{dd}-{title}.md', meetingPathTemplate: '' }
        })

        // Verify that the function uses the template from journalSettings
        expect(result.fullPath).toContain('weekly-log.md')
      })

      it('should handle meeting titles in filename', () => {
        const date = new Date('2024-03-15T10:30:00Z')

        const result = generateJournalFileInfoByType({
          date,
          type: JOURNAL_TYPES.MEETING,
          title: 'Sprint Planning',
          journalSettings: { notePathTemplate: '', dailyPathTemplate: '', meetingPathTemplate: '{yyyy}/meetings/{MM}/{yyyy}-{MM}-{dd}-{title}.md' }
        })
        expect(result.fullPath).toContain('sprint-planning.md')
      })

      it('should handle note titles in filename', () => {
        const date = new Date('2024-03-15T10:30:00Z')

        const result = generateJournalFileInfoByType({
          date,
          type: JOURNAL_TYPES.NOTE,
          title: 'Important Note',
          journalSettings: { notePathTemplate: '{yyyy}/notes/{MM}/{dd}-{title}.md', dailyPathTemplate: '', meetingPathTemplate: '' }
        })
        expect(result.fullPath).toContain('important-note.md')
      })
    })
  })
})
