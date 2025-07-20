import { useState } from 'react'
import { execCommand } from '../utils/exec.js'

export interface GitStatus {
  staged: string[]
  unstaged: string[]
  untracked: string[]
}

export function useGitOperations(cwd: string) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const getGitStatus = async (): Promise<GitStatus | null> => {
    try {
      setLoading(true)
      setError(null)
      
      const statusOutput = execCommand('git status --porcelain', cwd)
      const lines = statusOutput.trim().split('\n').filter((line: string) => line.length > 0)
      
      const staged = lines.filter((line: string) => line[0] !== ' ' && line[0] !== '?').map((line: string) => line.slice(3))
      const unstaged = lines.filter((line: string) => line[1] !== ' ' && line[1] !== '?').map((line: string) => line.slice(3))
      const untracked = lines.filter((line: string) => line.startsWith('??')).map((line: string) => line.slice(3))
      
      return { staged, unstaged, untracked }
    } catch (err) {
      setError('Failed to get git status')
      return null
    } finally {
      setLoading(false)
    }
  }

  const stageFiles = async (files: string[]): Promise<boolean> => {
    try {
      setLoading(true)
      setError(null)
      
      if (files.length === 0) return false
      
      const command = files.includes('.') ? 'git add .' : `git add ${files.map(f => `"${f}"`).join(' ')}`
      execCommand(command, cwd)
      return true
    } catch (err) {
      setError('Failed to stage files')
      return false
    } finally {
      setLoading(false)
    }
  }

  const commit = async (message: string): Promise<boolean> => {
    try {
      setLoading(true)
      setError(null)
      
      const escapedMessage = message.replace(/"/g, '\\"')
      execCommand(`git commit -m "${escapedMessage}"`, cwd)
      return true
    } catch (err) {
      setError('Failed to commit changes')
      return false
    } finally {
      setLoading(false)
    }
  }

  return {
    getGitStatus,
    stageFiles,
    commit,
    loading,
    error,
    clearError: () => setError(null)
  }
}