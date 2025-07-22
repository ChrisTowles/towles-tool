
import type { SettingsFile } from './settings'


// Note: the `Config` interface is used to define common configuration properties that are pased as context to various components and commands.
  
export interface Context {
  cwd: string
  settingsFile: SettingsFile
  args: string[]
}
export async function loadTowlesToolContext({
  cwd,
  settingsFile,
}: {
  cwd: string
  settingsFile: SettingsFile
}): Promise<Context> {

  // Load environment variables
  return {
    cwd: cwd!,
    settingsFile,
    args: [] // TODO: Load args from yargs
  } satisfies Context
}
