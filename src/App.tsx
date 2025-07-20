import { useState } from 'react'
import { Box, Text, render } from 'ink'
import type { Config } from './config/config.js'
import { AppProvider } from './contexts/AppContext.js'
import { ConfigProvider } from './contexts/ConfigContext.js'
import { ErrorBoundary } from './components/ErrorBoundary.js'
import { GitCommit } from './components/GitCommit.js'
import { ConfigDisplay } from './components/ConfigDisplay.js'
import { useTerminalSize } from './hooks/useTerminalSize.js'
import { DEFAULT_THEME } from './constants.js'

interface AppProps {
  config: Config
  command?: string
  commandArgs?: any[]
}

function AppContent({ config, command, commandArgs }: AppProps) {
  const [isExiting, setIsExiting] = useState(false)
  const terminalSize = useTerminalSize()

  const handleExit = (code = 0) => {
    setIsExiting(true)
    setTimeout(() => process.exit(code), 100)
  }

  if (isExiting) {
    return null
  }

  // Route to appropriate command component
  if (command === 'git-commit') {
    return (
      <GitCommit 
        config={config} 
        messageArgs={commandArgs as string[]} 
        onExit={handleExit} 
      />
    )
  }

  if (command === 'config') {
    return <ConfigDisplay config={config} />
  }

  // Default view
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color={DEFAULT_THEME.primary}>Towles Tool</Text>
      <Text color={DEFAULT_THEME.dim}>Terminal size: {terminalSize.columns}x{terminalSize.rows}</Text>
      <Text color={DEFAULT_THEME.warning}>No command specified</Text>
    </Box>
  )
}

export function App(props: AppProps) {
  return (
    <ErrorBoundary>
      <AppProvider>
        <ConfigProvider config={props.config}>
          <AppContent {...props} />
        </ConfigProvider>
      </AppProvider>
    </ErrorBoundary>
  )
}

export function renderApp(props: AppProps) {
  return render(<App {...props} />)
}