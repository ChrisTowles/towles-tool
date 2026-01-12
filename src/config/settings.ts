import { z } from 'zod/v4'
import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { AppInfo } from '../constants';
import consola from 'consola';
import { colors } from 'consola/utils';

/** Default config directory */
export const DEFAULT_CONFIG_DIR = path.join(homedir(), '.config', AppInfo.toolName);

/** User settings file path */
export const USER_SETTINGS_PATH = path.join(DEFAULT_CONFIG_DIR, `${AppInfo.toolName}.settings.json`);

/** Settings filename used within configDir */
export const SETTINGS_FILENAME = `${AppInfo.toolName}.settings.json`;

/** Get settings file path for a given configDir */
export function getSettingsPath(configDir: string): string {
  return path.join(configDir, SETTINGS_FILENAME);
}

export const JournalSettingsSchema = z.object({
    // Base folder where all journal files are stored
    baseFolder: z.string().default(path.join(homedir())),
    // https://moment.github.io/luxon/#/formatting?id=table-of-tokens
    dailyPathTemplate: z.string().default(path.join('journal/{monday:yyyy}/{monday:MM}/daily-notes/{monday:yyyy}-{monday:MM}-{monday:dd}-daily-notes.md')),
    meetingPathTemplate: z.string().default(path.join('journal/{yyyy}/{MM}/meetings/{yyyy}-{MM}-{dd}-{title}.md')),
    notePathTemplate: z.string().default(path.join('journal/{yyyy}/{MM}/notes/{yyyy}-{MM}-{dd}-{title}.md')),
    // Directory for external templates (fallback to hardcoded if not found)
    templateDir: z.string().default(path.join(homedir(), '.config', AppInfo.toolName, 'templates')),
})

export type JournalSettings = z.infer<typeof JournalSettingsSchema>

export const UserSettingsSchema = z.object({

  preferredEditor: z.string().default('code'),
  journalSettings: JournalSettingsSchema
})

type UserSettings = z.infer<typeof UserSettingsSchema>

export interface SettingsFile {
  settings: UserSettings;
  path: string;
}


// TODO refactor this.
export class LoadedSettings {
  constructor(
    settingsFile: SettingsFile,
  ) {
    this.settingsFile = settingsFile;

  }

  readonly settingsFile: SettingsFile;


}

function createDefaultSettings(): UserSettings {
  return UserSettingsSchema.parse({
    // NOTE: yes its odd zod can't use defaults from objects nested but it appears to be the case. 
    journalSettings: JournalSettingsSchema.parse({})
    
  });
}


function createSettingsFile(): UserSettings {

  let userSettings = createDefaultSettings()


  // Load user settings
  
    if (fs.existsSync(USER_SETTINGS_PATH)) {
      const userContent = fs.readFileSync(USER_SETTINGS_PATH, 'utf-8');
      const parsedUserSettings = JSON.parse(userContent) as unknown as UserSettings;
      userSettings = UserSettingsSchema.parse(parsedUserSettings);
    } else {
      saveSettings({
        path: USER_SETTINGS_PATH,
        settings: userSettings
      })
    }
  
    return userSettings
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

export async function loadSettings(): Promise<LoadedSettings> {

  let userSettings: UserSettings | null = null


  // Load user settings
  if (fs.existsSync(USER_SETTINGS_PATH)) {
    const userContent = fs.readFileSync(USER_SETTINGS_PATH, 'utf-8');
    const parsedUserSettings = JSON.parse(userContent) as unknown as UserSettings;


    userSettings = UserSettingsSchema.parse(parsedUserSettings);
    // made add a save here if the default values differ from the current values
    if (JSON.stringify(parsedUserSettings) !== JSON.stringify(userSettings)) {
      consola.warn(`Settings file ${USER_SETTINGS_PATH} has been updated with default values.`);
      const tempSettingsFile: SettingsFile = {
        path: USER_SETTINGS_PATH,
        settings: userSettings,
      };
      
      saveSettings(tempSettingsFile);
    }
  } else {
    // Settings file doesn't exist
    const isNonInteractive = process.env.CI || !process.stdout.isTTY;

    if (isNonInteractive) {
      // Auto-create in CI/non-TTY environments
      consola.info(`Creating settings file: ${USER_SETTINGS_PATH}`);
      userSettings = createSettingsFile();
    } else {
      // Interactive: ask user if they want to create it
      const confirmed = await consola.prompt(`Settings file not found. Create ${colors.cyan(USER_SETTINGS_PATH)}?`, {
        type: "confirm",
      });
      if (!confirmed) {
        throw new Error(`Settings file not found and user chose not to create it.`);
      }
      userSettings = createSettingsFile();
    }
  }

  return new LoadedSettings(
    {
      path: USER_SETTINGS_PATH,
      settings: userSettings!,
    }
  );
}

