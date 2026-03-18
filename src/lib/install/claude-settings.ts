import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

export interface ClaudeSettings {
  cleanupPeriodDays?: number;
  alwaysThinkingEnabled?: boolean;
  hooks?: Record<string, unknown[]>;
  [key: string]: unknown;
}

export const CLAUDE_SETTINGS_PATH = path.join(homedir(), ".claude", "settings.json");

/**
 * Load Claude settings from the given path.
 * Returns an empty object if the file is missing or contains invalid JSON.
 */
export function loadClaudeSettings(settingsPath: string): ClaudeSettings {
  if (!fs.existsSync(settingsPath)) {
    return {};
  }
  try {
    const content = fs.readFileSync(settingsPath, "utf-8");
    return JSON.parse(content) as ClaudeSettings;
  } catch {
    return {};
  }
}

/**
 * Pure function that applies recommended defaults and returns the updated
 * settings plus a list of human-readable change descriptions.
 */
export function applyRecommendedSettings(settings: ClaudeSettings): {
  settings: ClaudeSettings;
  changes: string[];
} {
  const result = { ...settings };
  const changes: string[] = [];

  if (result.cleanupPeriodDays !== 99999) {
    result.cleanupPeriodDays = 99999;
    changes.push("Set cleanupPeriodDays: 99999 (prevent log deletion)");
  }

  if (result.alwaysThinkingEnabled !== true) {
    result.alwaysThinkingEnabled = true;
    changes.push("Set alwaysThinkingEnabled: true");
  }

  return { settings: result, changes };
}

/**
 * Write Claude settings as formatted JSON to the given path,
 * creating parent directories if needed.
 */
export function saveClaudeSettings(settingsPath: string, settings: ClaudeSettings): void {
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}
