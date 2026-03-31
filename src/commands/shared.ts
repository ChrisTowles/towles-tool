import type { SettingsFile } from "../config/settings.js";
import { loadSettings } from "../config/settings.js";

export interface CommandContext {
  settingsFile: SettingsFile;
  settings: SettingsFile["settings"];
  debug: boolean;
}

export async function withSettings(debug = false): Promise<CommandContext> {
  const settingsFile = await loadSettings();
  return { settingsFile, settings: settingsFile.settings, debug };
}

/** Common debug flag definition for citty args */
export const debugArg = {
  type: "boolean" as const,
  alias: "d",
  description: "Enable debug output",
  default: false,
};
