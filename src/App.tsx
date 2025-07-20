import { useState } from 'react'
import { Box, Text, render } from 'ink'
import type { Config } from './config.js'
import type { AppView } from './types.js'
import { AppProvider, useApp } from './contexts/AppContext.js'
import { ConfigProvider } from './contexts/ConfigContext.js'
import { ErrorBoundary } from './components/ErrorBoundary.js'
import { GitCommit } from './components/GitCommit.js'
import { ConfigDisplay } from './components/ConfigDisplay.js'
import { Chat } from './components/Chat.js'
import { useTerminalSize } from './hooks/useTerminalSize.js'
import { DEFAULT_THEME } from './constants.js'

interface AppProps {
  config: Config
  command?: string
  commandArgs?: any[]
  initialView?: AppView
  initialArgs?: any[]
}

function AppContent() {
  const [isExiting, setIsExiting] = useState(false)
  const terminalSize = useTerminalSize()
  const { appState } = useApp()

  const handleExit = (code = 0) => {
    setIsExiting(true)
    setTimeout(() => process.exit(code), 100)
  }

  if (isExiting) {
    return null
  }

  // State-based routing
  switch (appState.currentView) {
    case 'git-commit':
      return (
        <GitCommit 
          messageArgs={appState.navigationArgs as string[]} 
          onExit={handleExit} 
        />
      )
    
    case 'config':
      return <ConfigDisplay />
    
    case 'journal':
      return (
        <Box flexDirection="column" padding={1}>
          <Text bold color={DEFAULT_THEME.primary}>Journal Mode</Text>
          <Text color={DEFAULT_THEME.dim}>Journal functionality will be implemented here</Text>
          <Text color={DEFAULT_THEME.dim}>Args: {JSON.stringify(appState.navigationArgs)}</Text>
        </Box>
      )
    
    case 'chat':
      return <Chat onExit={handleExit} />
    
    default:
      return (
        <Box flexDirection="column" padding={1}>
          <Text bold color={DEFAULT_THEME.primary}>Towles Tool</Text>
          <Text color={DEFAULT_THEME.dim}>Terminal size: {terminalSize.columns}x{terminalSize.rows}</Text>
          <Text color={DEFAULT_THEME.warning}>No command specified</Text>
          <Text color={DEFAULT_THEME.dim}>Use --help for available commands</Text>
        </Box>
      )
  }
}

export function App(props: AppProps) {
  return (
    <ErrorBoundary>
      <AppProvider 
        initialView={props.initialView} 
        initialArgs={props.initialArgs}
      >
        <ConfigProvider config={props.config}>
          <AppContent />
        </ConfigProvider>
      </AppProvider>
    </ErrorBoundary>
  )
}

export function renderApp(props: AppProps) {
  return render(<App {...props} />)
}