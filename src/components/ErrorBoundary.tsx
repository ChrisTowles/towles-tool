import { Component } from 'react'
import type { ReactNode, ErrorInfo } from 'react'
import { Box, Text } from 'ink'
import { DEFAULT_THEME } from '../constants.js'

interface ErrorBoundaryState {
  hasError: boolean
  error?: Error
}

interface ErrorBoundaryProps {
  children: ReactNode
  fallback?: ReactNode
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // console.error('Error caught by boundary:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <Box flexDirection="column" padding={1}>
          <Text bold color={DEFAULT_THEME.error}>Application Error</Text>
          <Text color={DEFAULT_THEME.error}>
            {this.state.error?.message || 'An unexpected error occurred'}
          </Text>
          <Text color={DEFAULT_THEME.dim}>Press ESC to exit</Text>
        </Box>
      )
    }

    return this.props.children
  }
}