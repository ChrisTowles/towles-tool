import { useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import { Box, Text } from 'ink'
import { DEFAULT_THEME } from '../constants.js'

interface AppWrapperProps {
  children: ReactNode
  isLoading?: boolean
  error?: string | null
}

export function AppWrapper({ children, isLoading = false, error }: AppWrapperProps) {
  const [showLoading, setShowLoading] = useState(isLoading)

  useEffect(() => {
    setShowLoading(isLoading)
  }, [isLoading])

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color={DEFAULT_THEME.error}>Error</Text>
        <Text color={DEFAULT_THEME.error}>{error}</Text>
        <Text color={DEFAULT_THEME.dim}>Press ESC to exit</Text>
      </Box>
    )
  }

  if (showLoading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={DEFAULT_THEME.primary}>Loading...</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {children}
    </Box>
  )
}