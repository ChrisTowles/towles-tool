import { z } from 'zod/v4'
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { AppInfo } from '../constants';
import stripJsonComments from 'strip-json-comments';
import { getErrorMessage } from '../lib/error';
import consola from 'consola';

export const USER_SETTINGS_DIR = path.join(homedir(), '.config', AppInfo.toolName);
export const USER_SETTINGS_PATH = path.join(USER_SETTINGS_DIR, `${AppInfo.toolName}.settings.json`);

export const JournalSettingsSchema = z.object({
  journalDir: z.string().default(path.join(homedir(), 'journal')),
})

export type JournalSettings = z.infer<typeof JournalSettingsSchema>

export const UserSettingsSchema = z.object({

  preferredEditor: z.string().default('code'),
  journalSettings: JournalSettingsSchema,


})

export type UserSettings = z.infer<typeof UserSettingsSchema>

export interface SettingsError {
  message: string;
  path: string;
}

export interface SettingsFile {
  settings: UserSettings;
  path: string;
}

export class LoadedSettings {
  constructor(
    settingsFile: SettingsFile,
    errors: SettingsError[],
  ) {
    this.settingsFile = settingsFile;
    this.errors = errors;
   
  }

  readonly settingsFile: SettingsFile;
  readonly errors: SettingsError[];

  // When we need to update a setting, we use this method
  // to ensure the settings file is updated and saved but comments are preserved.
  setValue<K extends keyof UserSettings>(
    key: K,
    value: UserSettings[K],
  ): void {
    this.settingsFile.settings[key] = value;
    saveSettings(this.settingsFile);
  }
}




export function loadSettings(): LoadedSettings {

  let userSettings: UserSettings = UserSettingsSchema.parse({});
  const settingsErrors: SettingsError[] = [];

  // Load user settings
  try {
    if (fs.existsSync(USER_SETTINGS_PATH)) {
      const userContent = fs.readFileSync(USER_SETTINGS_PATH, 'utf-8');
      const parsedUserSettings = JSON.parse(
        stripJsonComments(userContent),
      ) as UserSettings;
    
    }
  } catch (error: unknown) {
    settingsErrors.push({
      message: getErrorMessage(error),
      path: USER_SETTINGS_PATH,
    });
  }

  return new LoadedSettings(
    {
      path: USER_SETTINGS_PATH,
      settings: userSettings,
    },
    settingsErrors,
  );
}

export function saveSettings(settingsFile: SettingsFile): void {
  try {
    // Ensure the directory exists
    const dirPath = path.dirname(settingsFile.path);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    fs.writeFileSync(
      settingsFile.path,
      JSON.stringify(settingsFile.settings, null, 2),
      'utf-8',
    );
  } catch (error) {
    consola.error('Error saving user settings file:', error);
  }
}
