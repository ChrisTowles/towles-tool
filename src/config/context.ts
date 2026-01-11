
import type { SettingsFile } from './settings'


// Note: the `Config` interface is used to define common configuration properties that are pased as context to various components and commands.
  
export interface Context {
  cwd: string
  settingsFile: SettingsFile
  debug: boolean
}
export async function loadTowlesToolContext({
  cwd,
  settingsFile,
  debug = false
}: {
  cwd: string
  settingsFile: SettingsFile
  debug: boolean
}): Promise<Context> {

  return {
    cwd,
    settingsFile,
    debug,
  } satisfies Context
}
