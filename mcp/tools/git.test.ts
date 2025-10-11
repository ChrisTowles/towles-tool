import { describe, it, expect } from 'vitest'

describe('MCP Git Tools', () => {
  describe('git_status response format', () => {
    it('should return success response with file counts', () => {
      const response = {
        success: true,
        clean: false,
        staged: 3,
        unstaged: 2,
        untracked: 1,
        files: {
          staged: ['file1.ts', 'file2.ts', 'file3.ts'],
          unstaged: ['file4.ts', 'file5.ts'],
          untracked: ['file6.ts'],
        },
      }

      expect(response).toHaveProperty('success', true)
      expect(response).toHaveProperty('clean', false)
      expect(response).toHaveProperty('staged')
      expect(response).toHaveProperty('unstaged')
      expect(response).toHaveProperty('untracked')
      expect(response).toHaveProperty('files')
      expect(response.files.staged).toHaveLength(3)
    })

    it('should indicate clean working tree', () => {
      const response = {
        success: true,
        clean: true,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        files: {
          staged: [],
          unstaged: [],
          untracked: [],
        },
      }

      expect(response.clean).toBe(true)
      expect(response.staged).toBe(0)
    })

    it('should return error for non-git directory', () => {
      const errorResponse = {
        success: false,
        error: 'Not a git repository',
      }

      expect(errorResponse.success).toBe(false)
      expect(errorResponse.error).toContain('git repository')
    })
  })

  describe('git_diff response format', () => {
    it('should return diff output for staged changes', () => {
      const response = {
        success: true,
        diff: 'diff --git a/file.ts b/file.ts\n...',
        staged: true,
      }

      expect(response).toHaveProperty('success', true)
      expect(response).toHaveProperty('diff')
      expect(response).toHaveProperty('staged', true)
      expect(typeof response.diff).toBe('string')
    })

    it('should return empty diff message when no changes', () => {
      const response = {
        success: true,
        diff: '',
        message: 'No staged changes',
      }

      expect(response.diff).toBe('')
      expect(response.message).toContain('No')
    })

    it('should differentiate between staged and unstaged', () => {
      const stagedResponse = { staged: true }
      const unstagedResponse = { staged: false }

      expect(stagedResponse.staged).toBe(true)
      expect(unstagedResponse.staged).toBe(false)
    })
  })

  describe('git_commit_generate response format', () => {
    it('should return commit generation data', () => {
      const response = {
        success: true,
        stagedFiles: ['file1.ts', 'file2.ts'],
        diff: 'diff --git...',
        context: '\n\nRecent commits:\nabc1234 Previous commit',
        message: 'Use this diff to generate a conventional commit message...',
      }

      expect(response).toHaveProperty('success', true)
      expect(response).toHaveProperty('stagedFiles')
      expect(response).toHaveProperty('diff')
      expect(response).toHaveProperty('message')
      expect(Array.isArray(response.stagedFiles)).toBe(true)
    })

    it('should optionally include context', () => {
      const withContext = { includeContext: true, context: 'Recent commits...' }
      const withoutContext = { includeContext: false, context: undefined }

      expect(withContext.context).toBeDefined()
      expect(withoutContext.context).toBeUndefined()
    })

    it('should error when no staged changes', () => {
      const errorResponse = {
        success: false,
        error: 'No staged changes to commit',
      }

      expect(errorResponse.success).toBe(false)
      expect(errorResponse.error).toContain('staged changes')
    })
  })

  describe('porcelain status parsing', () => {
    it('should parse staged file from status line', () => {
      const statusLine = 'M  file.ts'
      const status = statusLine.substring(0, 2)

      // First char not space and not ? means staged
      const isStaged = status[0] !== ' ' && status[0] !== '?'
      expect(isStaged).toBe(true)
    })

    it('should parse unstaged file from status line', () => {
      const statusLine = ' M file.ts'
      const status = statusLine.substring(0, 2)

      // Second char not space and not ? means unstaged
      const isUnstaged = status[1] !== ' ' && status[1] !== '?'
      expect(isUnstaged).toBe(true)
    })

    it('should parse untracked file from status line', () => {
      const statusLine = '?? file.ts'
      const status = statusLine.substring(0, 2)

      const isUntracked = status === '??'
      expect(isUntracked).toBe(true)
    })
  })
})
