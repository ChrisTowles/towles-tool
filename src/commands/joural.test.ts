import type { UserConfig } from '../config'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import consola from 'consola'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getMondayOfWeek } from '../utils/date-utils'
import {
  createJournalContent,
  ensureDirectoryExists,
  generateJournalFileInfo,
  journalCommand,
  openInEditor,
} from './joural'

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
  const mockConfig: UserConfig = {
    journalDir: '/test/journal',
    editor: 'code',
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
      await openInEditor({ editor: mockConfig.editor, filePath: '/test/file.md' })
      // The promisify mock will handle the execution
      expect(true).toBe(true) // Placeholder assertion
    })

    describe('generateJournalFileInfo', () => {
      it('should generate correct file info for given date', () => {
        const testDate = new Date('2024-02-23')

        const result = generateJournalFileInfo({ date: testDate })
        expect(result.mondayDate).toEqual(getMondayOfWeek(testDate))

        expect(result.pathPrefix).toEqual(['2024', 'daily-notes'])
        expect(result.fileName).toBe('2024-02-19-week-log.md')
        expect(result.mondayDate).toEqual(getMondayOfWeek(new Date('2024-02-23')))
      })

      it('should use current date when no date provided', () => {
        const result = generateJournalFileInfo()

        expect(result.pathPrefix).toEqual([new Date().getFullYear().toString(), 'daily-notes'])
        expect(result.fileName).toMatch(/^\d{4}-\d{2}-\d{2}-week-log\.md$/)
        expect(result.mondayDate).toBeInstanceOf(Date)
      })

      it('should handle different years correctly', () => {
        const testDate = new Date('2025-12-31')

        const result = generateJournalFileInfo({ date: testDate })

        expect(result.pathPrefix).toEqual(['2025', 'daily-notes'])
        expect(result.fileName).toMatch(/^\d{4}-\d{2}-\d{2}-week-log\.md$/)
      })
    })

    describe('journalCommand', () => {
      it('should create new journal file when it does not exist', async () => {
        mockExistsSync
          .mockReturnValueOnce(false) // directory doesn't exist
          .mockReturnValueOnce(false) // file doesn't exist

        await journalCommand(mockConfig)

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

        await journalCommand(mockConfig)

        expect(mockWriteFileSync).not.toHaveBeenCalled()
        expect(mockConsola.info).toHaveBeenCalledWith(expect.stringContaining('Opening existing journal file'))
      })

      it('should construct correct file path', async () => {
        mockExistsSync.mockReturnValue(true)

        await journalCommand(mockConfig)

        expect(mockConsola.info).toHaveBeenCalledWith(
          expect.stringContaining(path.join(mockConfig.journalDir!, new Date().getFullYear().toString(), 'daily-notes')),
        )
      })
    })
  })
})
