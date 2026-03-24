import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "./logger";

/**
 * Write .claude/settings.local.json with hooks that POST to AgentBoard
 * callback endpoints for lifecycle events: Stop, StopFailure, Notification.
 */
export function writeHooks(
  slotPath: string,
  cardId: number,
  port: number,
  stopEndpoint: string,
): void {
  const claudeDir = resolve(slotPath, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const settingsPath = resolve(claudeDir, "settings.local.json");

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      // Corrupted file, start fresh
    }
  }

  const baseUrl = `http://localhost:${port}/api/agents/${cardId}`;
  const httpHook = (url: string) => [{ matcher: "", hooks: [{ type: "http", url }] }];

  settings.hooks = {
    ...(settings.hooks as Record<string, unknown> | undefined),
    Stop: httpHook(`${baseUrl}/${stopEndpoint}`),
    StopFailure: httpHook(`${baseUrl}/failure`),
    Notification: httpHook(`${baseUrl}/notification`),
  };

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  logger.info(`Wrote lifecycle hooks to ${settingsPath} → ${baseUrl}/${stopEndpoint}`);
}
