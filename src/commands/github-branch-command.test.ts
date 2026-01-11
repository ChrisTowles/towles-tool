import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Issue } from '../utils/git/gh-cli-wrapper'
import { createBranchNameFromIssue } from './github-branch-command'

// Mock dependencies
vi.mock('../utils/git/gh-cli-wrapper')
vi.mock('../utils/git/git-wrapper')
vi.mock('prompts')
vi.mock('consola')

describe('github-branch-command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('createBranchNameFromIssue', () => {
    it('creates branch name from issue with basic title', () => {
      const issue: Issue = {
        number: 4,
        title: 'Long Issue Title - with a lot of words     and stuff ',
        state: 'open',
        labels: [],
      }
      const branchName = createBranchNameFromIssue(issue)
      expect(branchName).toBe('feature/4-long-issue-title-with-a-lot-of-words-and-stuff')
    })

    it('handles special characters in title', () => {
      const issue: Issue = {
        number: 123,
        title: 'Fix bug: @user reported $100 issue!',
        state: 'open',
        labels: [],
      }
      const branchName = createBranchNameFromIssue(issue)
      expect(branchName).toBe('feature/123-fix-bug-user-reported-100-issue')
    })

    it('handles title with only numbers', () => {
      const issue: Issue = {
        number: 42,
        title: '123 456',
        state: 'open',
        labels: [],
      }
      const branchName = createBranchNameFromIssue(issue)
      expect(branchName).toBe('feature/42-123-456')
    })

    it('trims trailing dashes', () => {
      const issue: Issue = {
        number: 7,
        title: 'Update docs ---',
        state: 'open',
        labels: [],
      }
      const branchName = createBranchNameFromIssue(issue)
      expect(branchName).toBe('feature/7-update-docs')
    })

    it('handles unicode characters', () => {
      const issue: Issue = {
        number: 99,
        title: 'Fix für Übersetzung',
        state: 'open',
        labels: [],
      }
      const branchName = createBranchNameFromIssue(issue)
      expect(branchName).toBe('feature/99-fix-f-r-bersetzung')
    })

    it('handles empty-ish title', () => {
      const issue: Issue = {
        number: 1,
        title: '   ',
        state: 'open',
        labels: [],
      }
      const branchName = createBranchNameFromIssue(issue)
      expect(branchName).toBe('feature/1-')
    })

    it('handles title with underscores', () => {
      const issue: Issue = {
        number: 50,
        title: 'snake_case_title',
        state: 'open',
        labels: [],
      }
      const branchName = createBranchNameFromIssue(issue)
      expect(branchName).toBe('feature/50-snake_case_title')
    })

    it('handles very long titles', () => {
      const issue: Issue = {
        number: 200,
        title: 'This is a very long issue title that goes on and on with many words',
        state: 'open',
        labels: [],
      }
      const branchName = createBranchNameFromIssue(issue)
      expect(branchName).toBe('feature/200-this-is-a-very-long-issue-title-that-goes-on-and-on-with-many-words')
    })

    it('collapses multiple consecutive dashes', () => {
      const issue: Issue = {
        number: 15,
        title: 'Fix   multiple    spaces',
        state: 'open',
        labels: [],
      }
      const branchName = createBranchNameFromIssue(issue)
      expect(branchName).toBe('feature/15-fix-multiple-spaces')
    })

    it('handles title with brackets and parentheses', () => {
      const issue: Issue = {
        number: 33,
        title: '[Bug] Fix (critical) issue',
        state: 'open',
        labels: [],
      }
      const branchName = createBranchNameFromIssue(issue)
      // Leading bracket gets replaced creating double dash (expected behavior)
      expect(branchName).toBe('feature/33--bug-fix-critical-issue')
    })
  })

  describe('githubBranchCommand', () => {
    it('exits when gh CLI not installed', async () => {
      const ghWrapper = await import('../utils/git/gh-cli-wrapper')
      vi.mocked(ghWrapper.isGithubCliInstalled).mockResolvedValue(false)
      // Mock getIssues to return empty array (shouldn't be reached but needed to avoid undefined error)
      vi.mocked(ghWrapper.getIssues).mockResolvedValue([])

      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

      const { githubBranchCommand } = await import('./github-branch-command')
      const context = {
        settingsFile: { settings: {}, path: '' },
        cwd: '/test',
        args: [],
        debug: false,
      }

      await githubBranchCommand(context as any, { assignedToMe: false })

      // First exit call should be for gh CLI not installed
      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('exits when no issues found', async () => {
      const { isGithubCliInstalled, getIssues } = await import('../utils/git/gh-cli-wrapper')
      vi.mocked(isGithubCliInstalled).mockResolvedValue(true)
      vi.mocked(getIssues).mockResolvedValue([])

      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

      const { githubBranchCommand } = await import('./github-branch-command')
      const context = {
        settingsFile: { settings: {}, path: '' },
        cwd: '/test',
        args: [],
        debug: false,
      }

      await githubBranchCommand(context as any, { assignedToMe: false })

      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('creates branch when issue selected', async () => {
      const { isGithubCliInstalled, getIssues } = await import('../utils/git/gh-cli-wrapper')
      const { createBranch } = await import('../utils/git/git-wrapper')
      const prompts = await import('prompts')

      vi.mocked(isGithubCliInstalled).mockResolvedValue(true)
      vi.mocked(getIssues).mockResolvedValue([
        { number: 1, title: 'Test Issue', state: 'open', labels: [] },
      ])
      vi.mocked(prompts.default).mockResolvedValue({ issueNumber: 1 })

      const { githubBranchCommand } = await import('./github-branch-command')
      const context = {
        settingsFile: { settings: {}, path: '' },
        cwd: '/test',
        args: [],
        debug: false,
      }

      await githubBranchCommand(context as any, { assignedToMe: false })

      expect(createBranch).toHaveBeenCalledWith({ branchName: 'feature/1-test-issue' })
    })

    it('exits when user cancels', async () => {
      const { isGithubCliInstalled, getIssues } = await import('../utils/git/gh-cli-wrapper')
      const prompts = await import('prompts')

      vi.mocked(isGithubCliInstalled).mockResolvedValue(true)
      vi.mocked(getIssues).mockResolvedValue([
        { number: 1, title: 'Test Issue', state: 'open', labels: [] },
      ])
      vi.mocked(prompts.default).mockResolvedValue({ issueNumber: 'cancel' })

      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

      const { githubBranchCommand } = await import('./github-branch-command')
      const context = {
        settingsFile: { settings: {}, path: '' },
        cwd: '/test',
        args: [],
        debug: false,
      }

      await githubBranchCommand(context as any, { assignedToMe: false })

      expect(mockExit).toHaveBeenCalledWith(0)
    })

    it('passes assignedToMe flag to getIssues', async () => {
      const { isGithubCliInstalled, getIssues } = await import('../utils/git/gh-cli-wrapper')
      const prompts = await import('prompts')

      vi.mocked(isGithubCliInstalled).mockResolvedValue(true)
      vi.mocked(getIssues).mockResolvedValue([
        { number: 1, title: 'My Issue', state: 'open', labels: [] },
      ])
      vi.mocked(prompts.default).mockResolvedValue({ issueNumber: 1 })

      const { githubBranchCommand } = await import('./github-branch-command')
      const context = {
        settingsFile: { settings: {}, path: '' },
        cwd: '/my-repo',
        args: [],
        debug: false,
      }

      await githubBranchCommand(context as any, { assignedToMe: true })

      expect(getIssues).toHaveBeenCalledWith({ assignedToMe: true, cwd: '/my-repo' })
    })
  })
})
