import type { SettingsFile } from './settings'

export interface Context {
  cwd: string
  settingsFile: SettingsFile
  debug: boolean
}
