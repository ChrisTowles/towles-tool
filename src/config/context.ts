
import type { SettingsFile } from './settings'


// Note: the `Config` interface is used to define common configuration properties that are pased as context to various components and commands.
  
export interface Context {
  cwd: string
  settingsFile: SettingsFile
  args: string[],
  debug: boolean // useful for debugging purposes, can be toggled on or off
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

  // Load environment variables
  return {
    cwd: cwd!,
    settingsFile,
    args: [], // TODO: Load args from yargs
    debug: debug 
  } satisfies Context
}
