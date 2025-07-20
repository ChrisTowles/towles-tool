export type AppView = 'journal' | 'git-commit' | 'config' | 'chat' | 'default'

export interface AppState {
  isLoading: boolean
  error: string | null
  currentCommand: string | null
  currentView: AppView
  navigationArgs?: any[]
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  isStreaming?: boolean
}

export interface ChatState {
  messages: Message[]
  isStreaming: boolean
  currentInput: string
  streamingMessageId: string | null
}

export interface TerminalSize {
  columns: number
  rows: number
}

export interface UITheme {
  primary: string
  secondary: string
  success: string
  warning: string
  error: string
  dim: string
}

export type CommandMode = 'interactive' | 'non-interactive'

export interface CommandContext {
  mode: CommandMode
  exitCode: number
  onExit: (code?: number) => void
}