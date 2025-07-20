import { createContext, useContext, useState } from 'react'
import type { ReactNode } from 'react'
import type { AppState, CommandContext, ChatState, AppView } from '../types.js'

interface AppContextValue {
  appState: AppState
  updateAppState: (updates: Partial<AppState>) => void
  commandContext: CommandContext
  updateCommandContext: (updates: Partial<CommandContext>) => void
  chatState: ChatState
  updateChatState: (updates: Partial<ChatState>) => void
  navigateToView: (view: AppView, args?: any[]) => void
}

const AppContext = createContext<AppContextValue | null>(null)

interface AppProviderProps {
  children: ReactNode
  initialCommandContext?: Partial<CommandContext>
  initialView?: AppView
  initialArgs?: any[]
}

export function AppProvider({ children, initialCommandContext, initialView = 'default', initialArgs }: AppProviderProps) {
  const [appState, setAppState] = useState<AppState>({
    isLoading: false,
    error: null,
    currentCommand: null,
    currentView: initialView,
    navigationArgs: initialArgs
  })

  const [commandContext, setCommandContext] = useState<CommandContext>({
    mode: 'interactive',
    exitCode: 0,
    onExit: (code = 0) => process.exit(code),
    ...initialCommandContext
  })

  const [chatState, setChatState] = useState<ChatState>({
    messages: [],
    isStreaming: false,
    currentInput: '',
    streamingMessageId: null
  })

  const updateAppState = (updates: Partial<AppState>) => {
    setAppState(prev => ({ ...prev, ...updates }))
  }

  const updateCommandContext = (updates: Partial<CommandContext>) => {
    setCommandContext(prev => ({ ...prev, ...updates }))
  }

  const updateChatState = (updates: Partial<ChatState>) => {
    setChatState(prev => ({ ...prev, ...updates }))
  }

  const navigateToView = (view: AppView, args?: any[]) => {
    updateAppState({ currentView: view, navigationArgs: args })
  }

  return (
    <AppContext.Provider value={{
      appState,
      updateAppState,
      commandContext,
      updateCommandContext,
      chatState,
      updateChatState,
      navigateToView
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