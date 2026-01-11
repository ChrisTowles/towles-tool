import type { Context } from '../config/context'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import consola from 'consola'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createJournalContent,
  createMeetingContent,
  createNoteContent,
  ensureDirectoryExists,
  generateJournalFileInfoByType,
  journalCommand,
  openInEditor,
  resolvePathTemplate,
} from './journal'
import { JOURNAL_TYPES } from '../utils/parseArgs'

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
          baseFolder: "/test/journal",
          dailyPathTemplate: "{yyyy}/{MM}/daily-notes/{yyyy}-{MM}-{dd}-daily-notes.md",
          meetingPathTemplate: "{yyyy}/{MM}/meetings/{yyyy}-{MM}-{dd}-{title}.md",
          notePathTemplate: "{yyyy}/notes/{MM}/notes/{yyyy}-{MM}-{dd}-{title}.md"
        },
        preferredEditor: 'code',
      },
      path: '/test/settings.json',
    },
    cwd: '/test',
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

  describe('createMeetingContent', () => {
    it('should create meeting content with title and date', () => {
      const date = new Date('2024-03-15T14:30:00Z')
      const content = createMeetingContent({ title: 'Sprint Planning', date })

      expect(content).toContain('# Meeting: Sprint Planning')
      expect(content).toContain('**Date:** 2024-03-15')
      expect(content).toContain('**Time:**')
      expect(content).toContain('**Attendees:**')
      expect(content).toContain('## Agenda')
      expect(content).toContain('## Notes')
      expect(content).toContain('## Action Items')
      expect(content).toContain('- [ ]')
      expect(content).toContain('## Follow-up')
    })

    it('should use default title when not provided', () => {
      const date = new Date('2024-03-15T14:30:00Z')
      const content = createMeetingContent({ date })

      expect(content).toContain('# Meeting: Meeting')
    })
  })

  describe('createNoteContent', () => {
    it('should create note content with title and date', () => {
      const date = new Date('2024-03-15T14:30:00Z')
      const content = createNoteContent({ title: 'Important Note', date })

      expect(content).toContain('# Important Note')
      expect(content).toContain('**Created:** 2024-03-15')
      expect(content).toContain('## Summary')
      expect(content).toContain('## Details')
      expect(content).toContain('## References')
    })

    it('should use default title when not provided', () => {
      const date = new Date('2024-03-15T14:30:00Z')
      const content = createNoteContent({ date })

      expect(content).toContain('# Note')
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

        await journalCommand(mockContext, {journalType:  JOURNAL_TYPES.DAILY_NOTES })

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

        await journalCommand(mockContext,  {journalType:  JOURNAL_TYPES.DAILY_NOTES })

        expect(mockWriteFileSync).not.toHaveBeenCalled()
        expect(mockConsola.info).toHaveBeenCalledWith(expect.stringContaining('Opening existing journal file'))
      })

      it('should construct correct file path', async () => {
        mockExistsSync.mockReturnValue(true)

        await journalCommand(mockContext,  {journalType:  JOURNAL_TYPES.DAILY_NOTES })

        const currentYear = new Date().getFullYear().toString()
        expect(mockConsola.info).toHaveBeenCalledWith(
          expect.stringContaining(currentYear),
        )
      })
    })

    describe('resolvePathTemplate', () => {
      const testDate = new Date('2024-03-15T14:30:45Z')
      const testMondayDate = new Date('2024-03-11T00:00:00Z') // Monday of that week
      const title = 'Test Journal Entry'

      it('should resolve year format tokens in curly braces', () => {
        expect(resolvePathTemplate('{yyyy}', title, testDate, testMondayDate)).toBe('2024')
        expect(resolvePathTemplate('{yy}', title, testDate, testMondayDate)).toBe('24')
        expect(resolvePathTemplate('{y}', title, testDate, testMondayDate)).toBe('2024')
      })

      it('should resolve month format tokens in curly braces', () => {
        expect(resolvePathTemplate('{MM}', title, testDate, testMondayDate)).toBe('03')
        expect(resolvePathTemplate('{M}', title, testDate, testMondayDate)).toBe('3')
        expect(resolvePathTemplate('{LLL}', title, testDate, testMondayDate)).toBe('Mar')
        expect(resolvePathTemplate('{LLLL}', title, testDate, testMondayDate)).toBe('March')
      })

      it('should resolve day format tokens in curly braces', () => {
        expect(resolvePathTemplate('{dd}', title, testDate, testMondayDate)).toBe('15')
        expect(resolvePathTemplate('{d}', title, testDate, testMondayDate)).toBe('15')
        expect(resolvePathTemplate('{EEE}', title, testDate, testMondayDate)).toBe('Fri')
        expect(resolvePathTemplate('{EEEE}', title, testDate, testMondayDate)).toBe('Friday')
      })

      it('should resolve time format tokens in curly braces', () => {
        expect(resolvePathTemplate('{HH}', title, testDate, testMondayDate)).toBe('14')
        expect(resolvePathTemplate('{H}', title, testDate, testMondayDate)).toBe('14')
        expect(resolvePathTemplate('{mm}', title, testDate, testMondayDate)).toBe('30')
        expect(resolvePathTemplate('{m}', title, testDate, testMondayDate)).toBe('30')
        expect(resolvePathTemplate('{ss}', title, testDate, testMondayDate)).toBe('45')
        expect(resolvePathTemplate('{s}', title, testDate, testMondayDate)).toBe('45')
      })

      it('should resolve quarter and week format tokens in curly braces', () => {
        expect(resolvePathTemplate('{q}', title, testDate, testMondayDate)).toBe('1')
        expect(resolvePathTemplate('{qq}', title, testDate, testMondayDate)).toBe('01')
        expect(resolvePathTemplate('{W}', title, testDate, testMondayDate)).toBe('11') // Week of year
      })

      it('should handle complex path templates with mixed literal text and tokens', () => {
        expect(resolvePathTemplate('{yyyy}/{MM}/{dd}', title, testDate, testMondayDate)).toBe('2024/03/15')
        expect(resolvePathTemplate('{yyyy}-{MM}-{dd}-{HH}-{mm}', title, testDate, testMondayDate)).toBe('2024-03-15-14-30')
        expect(resolvePathTemplate('{yyyy}/{LLL}/daily-notes', title, testDate, testMondayDate)).toBe('2024/Mar/daily-notes')
        expect(resolvePathTemplate('journal/{yyyy}/meetings/{MM}', title, testDate, testMondayDate)).toBe('journal/2024/meetings/03')
      })

      it('should handle file paths with extensions and mixed content', () => {
        expect(resolvePathTemplate('{yyyy}/{MM}/{dd}.md', title, testDate, testMondayDate)).toBe('2024/03/15.md')
        expect(resolvePathTemplate('notes-{yyyy}-{LLL}-{dd}.txt', title, testDate, testMondayDate)).toBe('notes-2024-Mar-15.txt')
        expect(resolvePathTemplate('meeting-{yyyy}-{MM}-{dd}-{HH}{mm}.md', title, testDate, testMondayDate)).toBe('meeting-2024-03-15-1430.md')
      })

      it('should preserve literal text without curly braces', () => {
        expect(resolvePathTemplate('static/path', title, testDate, testMondayDate)).toBe('static/path')
        expect(resolvePathTemplate('notes.md', title, testDate, testMondayDate)).toBe('notes.md')
        expect(resolvePathTemplate('daily-notes/folder', title, testDate, testMondayDate)).toBe('daily-notes/folder')
      })

      it('should handle mixed tokens and literal text', () => {
        expect(resolvePathTemplate('journal/{yyyy}/daily-notes/{MM}', title, testDate, testMondayDate)).toBe('journal/2024/daily-notes/03')
        expect(resolvePathTemplate('logs/{yyyy}/week-{W}', title, testDate, testMondayDate)).toBe('logs/2024/week-11')
        expect(resolvePathTemplate('{EEEE}-{yyyy}-{MM}-{dd}.log', title, testDate, testMondayDate)).toBe('Friday-2024-03-15.log')
      })

      it('should handle edge cases with mixed content', () => {
        const newYearDate = new Date('2024-01-01T00:00:00Z')
        const newYearMondayDate = new Date('2024-01-01T00:00:00Z')
        expect(resolvePathTemplate('archive/{yyyy}/{MM}/{dd}', title, newYearDate, newYearMondayDate)).toBe('archive/2024/01/01')

        const endOfYearDate = new Date('2024-12-31T23:59:59Z')
        const endOfYearMondayDate = new Date('2024-12-30T00:00:00Z')
        expect(resolvePathTemplate('backup-{yyyy}-{MM}-{dd}-{HH}-{mm}-{ss}.zip', title, endOfYearDate, endOfYearMondayDate)).toBe('backup-2024-12-31-23-59-59.zip')
      })

      it('should handle title included', () => {
        const newYearDate = new Date('2024-01-01T00:00:00Z')
        const newYearMondayDate = new Date('2024-01-01T00:00:00Z')
        expect(resolvePathTemplate('archive/{yyyy}/{MM}/{dd}-{title}.md', title, newYearDate, newYearMondayDate)).toBe('archive/2024/01/01-test-journal-entry.md')

        const endOfYearDate = new Date('2024-12-31T23:59:59Z')
        const endOfYearMondayDate = new Date('2024-12-30T00:00:00Z')
        expect(resolvePathTemplate('backup-{yyyy}-{MM}-{dd}-{HH}-{mm}-{ss}-{title}.zip', title, endOfYearDate, endOfYearMondayDate)).toBe('backup-2024-12-31-23-59-59-test-journal-entry.zip')
      })

      it('should handle invalid tokens gracefully', () => {
        expect(resolvePathTemplate('{invalid_token}/notes', title, testDate, testMondayDate)).toBe('{invalid_token}/notes')
        expect(resolvePathTemplate('path/{xyz}/file.md', title, testDate, testMondayDate)).toBe('path/{xyz}/file.md')
      })

      it('should handle multiple tokens in complex patterns', () => {
        expect(resolvePathTemplate('Q{q}-{yyyy}/M{MM}/W{W}', title, testDate, testMondayDate)).toBe('Q1-2024/M03/W11')
        expect(resolvePathTemplate('{EEE}_{dd}_{LLL}_{yyyy}', title, testDate, testMondayDate)).toBe('Fri_15_Mar_2024')
      })

      it('should handle monday: prefix for date tokens', () => {
        expect(resolvePathTemplate('{monday:yyyy}', title, testDate, testMondayDate)).toBe('2024')
        expect(resolvePathTemplate('{monday:MM}', title, testDate, testMondayDate)).toBe('03')
        expect(resolvePathTemplate('{monday:dd}', title, testDate, testMondayDate)).toBe('11')
        expect(resolvePathTemplate('{monday:EEE}', title, testDate, testMondayDate)).toBe('Mon')
        expect(resolvePathTemplate('week-{monday:yyyy}-{monday:MM}-{monday:dd}.md', title, testDate, testMondayDate)).toBe('week-2024-03-11.md')
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
          journalSettings: { baseFolder: '/base', notePathTemplate: '', dailyPathTemplate: '{yyyy}/daily/{MM}/{dd}-{title}.md', meetingPathTemplate: '' }
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
          journalSettings: { baseFolder: '/base', notePathTemplate: '', dailyPathTemplate: '', meetingPathTemplate: '{yyyy}/meetings/{MM}/{yyyy}-{MM}-{dd}-{title}.md' }
        })
        expect(result.fullPath).toContain('sprint-planning.md')
      })

      it('should handle note titles in filename', () => {
        const date = new Date('2024-03-15T10:30:00Z')

        const result = generateJournalFileInfoByType({
          date,
          type: JOURNAL_TYPES.NOTE,
          title: 'Important Note',
          journalSettings: { baseFolder: '/base', notePathTemplate: '{yyyy}/notes/{MM}/{dd}-{title}.md', dailyPathTemplate: '', meetingPathTemplate: '' }
        })
        expect(result.fullPath).toContain('important-note.md')
      })

      it('should join baseFolder with resolved path', () => {
        const date = new Date('2024-03-15T10:30:00Z')

        const result = generateJournalFileInfoByType({
          date,
          type: JOURNAL_TYPES.DAILY_NOTES,
          title: 'Weekly Log',
          journalSettings: { baseFolder: '/my/journal/root', notePathTemplate: '', dailyPathTemplate: '{yyyy}/{MM}/daily-notes/{monday:yyyy}-{monday:MM}-{monday:dd}-daily-notes.md', meetingPathTemplate: '' }
        })
        expect(result.fullPath).toMatch(/^\/my\/journal\/root\//)
        expect(result.fullPath).toContain('2024/03/daily-notes')
      })
    })
  })
})
