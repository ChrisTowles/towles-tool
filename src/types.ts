export interface AppState {
  isLoading: boolean
  error: string | null
  currentCommand: string | null
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