import type { UITheme } from "./types"

export const constants = {
  toolName: 'towles-tool',
}

export const DEFAULT_THEME: UITheme = {
  primary: 'cyan',
  secondary: 'blue',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  dim: 'dim'
}

export const UI_CONSTANTS = {
  MIN_TERMINAL_WIDTH: 80,
  MIN_TERMINAL_HEIGHT: 24,
  LOADING_SPINNER_INTERVAL: 100,
  DEFAULT_PADDING: 1
} as const