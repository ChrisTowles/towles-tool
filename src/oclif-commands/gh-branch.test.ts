import { describe, expect, it } from 'bun:test'
import type { Issue } from '../utils/git/gh-cli-wrapper'
import GhBranch from './gh-branch'

const createBranchNameFromIssue = GhBranch.createBranchNameFromIssue

describe('gh-branch', () => {
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
      expect(branchName).toBe('feature/33--bug-fix-critical-issue')
    })
  })

  // TODO: Integration tests for githubBranchCommand require module mocking
  // which works differently in bun:test vs vitest
})
