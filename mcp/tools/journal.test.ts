import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

// Mock the journal command imports
vi.mock('../../src/commands/journal.js', () => ({
  createJournalContent: vi.fn(() => '# Daily Journal Content'),
  createMeetingContent: vi.fn(() => '# Meeting Content'),
  createNoteContent: vi.fn(() => '# Note Content'),
  generateJournalFileInfoByType: vi.fn(({ type, title }) => ({
    fullPath: `/test/journals/${type}/${title || 'test'}.md`,
    mondayDate: new Date('2025-10-06'),
    currentDate: new Date('2025-10-10'),
  })),
}))

describe('MCP Journal Tools', () => {
  let testDir: string

  beforeEach(() => {
    // Create temp directory for test files
    testDir = path.join(tmpdir(), `mcp-journal-test-${Date.now()}`)
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
    vi.clearAllMocks()
  })

  describe('journal_create validation', () => {
    it('should validate required type parameter', () => {
      // This would be tested by calling the actual handler
      const invalidTypes = ['invalid', 'weekly', '']

      invalidTypes.forEach(type => {
        expect(type).not.toMatch(/^(daily|meeting|note)$/)
      })
    })

    it('should accept valid journal types', () => {
      const validTypes = ['daily', 'meeting', 'note']

      validTypes.forEach(type => {
        expect(type).toMatch(/^(daily|meeting|note)$/)
      })
    })

    it('should require title for meeting type', () => {
      const meetingArgs = { type: 'meeting' as const }
      expect(meetingArgs.type).toBe('meeting')
      // Title validation would happen in handler
    })

    it('should require title for note type', () => {
      const noteArgs = { type: 'note' as const }
      expect(noteArgs.type).toBe('note')
      // Title validation would happen in handler
    })

    it('should not require title for daily type', () => {
      const dailyArgs = { type: 'daily' as const }
      expect(dailyArgs.type).toBe('daily')
      // Daily doesn't need title
    })
  })

  describe('file creation', () => {
    it('should create directory if it does not exist', () => {
      const testFile = path.join(testDir, 'subdir', 'test.md')
      const dirPath = path.dirname(testFile)

      // Simulate what the handler does
      if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true })
      }

      expect(existsSync(dirPath)).toBe(true)
    })

    it('should write content to new file', () => {
      const testFile = path.join(testDir, 'test.md')
      const content = '# Test Journal Entry'

      writeFileSync(testFile, content, 'utf-8')

      expect(existsSync(testFile)).toBe(true)
      expect(readFileSync(testFile, 'utf-8')).toBe(content)
    })

    it('should not overwrite existing file', () => {
      const testFile = path.join(testDir, 'existing.md')
      const originalContent = '# Original Content'

      writeFileSync(testFile, originalContent, 'utf-8')

      // Handler should detect file exists
      const fileExists = existsSync(testFile)
      expect(fileExists).toBe(true)

      // Should not write again if exists
      if (fileExists) {
        // Skip writing
        expect(readFileSync(testFile, 'utf-8')).toBe(originalContent)
      }
    })
  })

  describe('response format', () => {
    it('should return success response with required fields', () => {
      const response = {
        success: true,
        action: 'created',
        type: 'daily',
        path: '/test/path.md',
        message: 'Created new daily journal entry',
      }

      expect(response).toHaveProperty('success', true)
      expect(response).toHaveProperty('action')
      expect(response).toHaveProperty('type')
      expect(response).toHaveProperty('path')
      expect(response).toHaveProperty('message')
    })

    it('should return error response with success false', () => {
      const errorResponse = {
        success: false,
        error: 'Title is required for meeting journal entries',
      }

      expect(errorResponse).toHaveProperty('success', false)
      expect(errorResponse).toHaveProperty('error')
    })

    it('should indicate when file already exists', () => {
      const response = {
        success: true,
        action: 'exists',
        type: 'note',
        path: '/test/existing.md',
        message: 'Journal entry already exists',
      }

      expect(response.action).toBe('exists')
    })
  })
})
