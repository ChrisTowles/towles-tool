import { useState, useEffect } from 'react'
import { Box, Text, useInput} from 'ink'
import type { Key as InkKeyType } from 'ink'
import { useGitOperations } from '../hooks/useGitOperations.js'
import type { Context } from '../config/context.js'
interface GitCommitProps {
  context: Context
  messageArgs?: string[]
  onExit: () => void
}

type Step = 'loading' | 'status' | 'staging' | 'message' | 'commit' | 'success' | 'error'

export function GitCommit({ context, messageArgs, onExit }: GitCommitProps) {
  const { getGitStatus, stageFiles, commit, loading, error } = useGitOperations(context.cwd)
  const [step, setStep] = useState<Step>('loading')
  const [gitStatus, setGitStatus] = useState<{ staged: string[], unstaged: string[], untracked: string[] } | null>(null)
  const [commitMessage, setCommitMessage] = useState(messageArgs?.join(' ') || '')
  const [userInput, setUserInput] = useState('')
  const [waitingForInput, setWaitingForInput] = useState(false)

  // Initialize git status
  useEffect(() => {
    async function init() {
      const status = await getGitStatus()
      if (status) {
        setGitStatus(status)
        
        if (status.staged.length === 0 && status.unstaged.length === 0 && status.untracked.length === 0) {
          setStep('success') // Nothing to commit
        } else if (status.staged.length === 0) {
          setStep('staging') // Need to stage files
          setWaitingForInput(true)
        } else if (messageArgs && messageArgs.length > 0) {
          setStep('commit') // Direct commit with provided message
          setCommitMessage(messageArgs.join(' '))
        } else {
          setStep('message') // Get commit message
          setWaitingForInput(true)
        }
      } else {
        setStep('error')
      }
    }
    init()
  }, [])

  // Handle keyboard input
  useInput((input, key: InkKeyType) => {
    if (key.escape) {
      onExit()
      return
    }

    if (step === 'staging' && waitingForInput) {
      if (input === 'y' || input === 'Y' || key.return) {
        handleStageFiles()
      } else if (input === 'n' || input === 'N') {
        onExit()
      }
    } else if (step === 'message' && waitingForInput) {
      if (key.return && userInput.trim()) {
        setCommitMessage(userInput.trim())
        setStep('commit')
        setWaitingForInput(false)
      } else if (key.backspace || key.delete) {
        setUserInput(prev => prev.slice(0, -1))
      } else if (input && !key.ctrl && !key.meta) {
        setUserInput(prev => prev + input)
      }
    }
  })

  // Handle staging files
  const handleStageFiles = async () => {
    setWaitingForInput(false)
    const success = await stageFiles(['.'])
    if (success) {
      const newStatus = await getGitStatus()
      if (newStatus) {
        setGitStatus(newStatus)
        if (messageArgs && messageArgs.length > 0) {
          setStep('commit')
        } else {
          setStep('message')
          setWaitingForInput(true)
        }
      }
    } else {
      setStep('error')
    }
  }

  // Handle final commit
  useEffect(() => {
    if (step === 'commit' && commitMessage && !waitingForInput) {
      async function performCommit() {
        const success = await commit(commitMessage)
        if (success) {
          setStep('success')
        } else {
          setStep('error')
        }
      }
      performCommit()
    }
  }, [step, commitMessage, waitingForInput])

  if (step === 'loading' || loading) {
    return (
      <Box>
        <Text>Loading git status...</Text>
      </Box>
    )
  }

  if (step === 'error' || error) {
    return (
      <Box flexDirection="column">
        <Text color="red">Error: {error || 'An error occurred'}</Text>
        <Text color="dim">Press ESC to exit</Text>
      </Box>
    )
  }

  if (step === 'success') {
    if (!gitStatus || (gitStatus.staged.length === 0 && gitStatus.unstaged.length === 0 && gitStatus.untracked.length === 0)) {
      return (
        <Box flexDirection="column">
          <Text color="green">✓ Working tree clean - nothing to commit</Text>
          <Text color="dim">Press ESC to exit</Text>
        </Box>
      )
    } else {
      return (
        <Box flexDirection="column">
          <Text color="green">✓ Commit created successfully!</Text>
          <Text color="dim">Press ESC to exit</Text>
        </Box>
      )
    }
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Git Commit</Text>
      
      {/* Status Display */}
      {gitStatus && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Current Status:</Text>
          
          {gitStatus.staged.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text color="green">✓ Staged files ({gitStatus.staged.length}):</Text>
              {gitStatus.staged.slice(0, 5).map(file => (
                <Text key={file} color="green">  {file}</Text>
              ))}
              {gitStatus.staged.length > 5 && (
                <Text color="green">  ... and {gitStatus.staged.length - 5} more</Text>
              )}
            </Box>
          )}
          
          {gitStatus.unstaged.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text color="yellow">M Modified files ({gitStatus.unstaged.length}):</Text>
              {gitStatus.unstaged.slice(0, 3).map(file => (
                <Text key={file} color="yellow">  {file}</Text>
              ))}
              {gitStatus.unstaged.length > 3 && (
                <Text color="yellow">  ... and {gitStatus.unstaged.length - 3} more</Text>
              )}
            </Box>
          )}
          
          {gitStatus.untracked.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text color="red">? Untracked files ({gitStatus.untracked.length}):</Text>
              {gitStatus.untracked.slice(0, 3).map(file => (
                <Text key={file} color="red">  {file}</Text>
              ))}
              {gitStatus.untracked.length > 3 && (
                <Text color="red">  ... and {gitStatus.untracked.length - 3} more</Text>
              )}
            </Box>
          )}
        </Box>
      )}

      {/* Interactive Steps */}
      <Box marginTop={2} flexDirection="column">
        {step === 'staging' && waitingForInput && (
          <Box flexDirection="column">
            <Text color="yellow">No files are staged. Add all modified and untracked files? (y/N)</Text>
            <Text color="dim">Press y for yes, n for no, or ESC to cancel</Text>
          </Box>
        )}
        
        {step === 'message' && waitingForInput && (
          <Box flexDirection="column">
            <Text color="yellow">Enter commit message:</Text>
            <Box>
              <Text color="cyan">{'> '}</Text>
              <Text>{userInput}</Text>
              <Text color="dim">{'█'}</Text>
            </Box>
            <Text color="dim">Press Enter to commit, ESC to cancel</Text>
          </Box>
        )}
        
        {step === 'commit' && (
          <Text color="yellow">Committing changes...</Text>
        )}
      </Box>

      <Box marginTop={1}>
        <Text color="dim">Press ESC to cancel</Text>
      </Box>
    </Box>
  )
}