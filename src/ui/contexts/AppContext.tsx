import { createContext, useContext, useState } from 'react'
import type { ReactNode } from 'react'
import type { AppState, CommandContext } from '../types.js'

interface AppContextValue {
  appState: AppState
  updateAppState: (updates: Partial<AppState>) => void
  commandContext: CommandContext
  updateCommandContext: (updates: Partial<CommandContext>) => void
}

const AppContext = createContext<AppContextValue | null>(null)

interface AppProviderProps {
  children: ReactNode
  initialCommandContext?: Partial<CommandContext>
}

export function AppProvider({ children, initialCommandContext }: AppProviderProps) {
  const [appState, setAppState] = useState<AppState>({
    isLoading: false,
    error: null,
    currentCommand: null
  })

  const [commandContext, setCommandContext] = useState<CommandContext>({
    mode: 'interactive',
    exitCode: 0,
    onExit: (code = 0) => process.exit(code),
    ...initialCommandContext
  })

  const updateAppState = (updates: Partial<AppState>) => {
    setAppState(prev => ({ ...prev, ...updates }))
  }

  const updateCommandContext = (updates: Partial<CommandContext>) => {
    setCommandContext(prev => ({ ...prev, ...updates }))
  }

  return (
    <AppContext.Provider value={{
      appState,
      updateAppState,
      commandContext,
      updateCommandContext
    }}>
      {children}
    </AppContext.Provider>
  )
}

export function useApp() {
  const context = useContext(AppContext)
  if (!context) {
    throw new Error('useApp must be used within an AppProvider')
  }
  return context
}