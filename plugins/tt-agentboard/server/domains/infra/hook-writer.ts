import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../../utils/logger";

function commandHook(cardId: number, port: number, scriptPath: string) {
  return [
    {
      matcher: "",
      hooks: [
        {
          type: "command",
          command: `AGENTBOARD_CARD_ID=${cardId} AGENTBOARD_PORT=${port} ${scriptPath}`,
          timeout: 120,
        },
      ],
    },
  ];
}

/**
 * Write .claude/settings.local.json with command hooks that POST to AgentBoard
 * callback endpoints with exponential backoff retry.
 *
 * Uses command hooks (not HTTP hooks) so that transient server restarts
 * don't silently lose the completion signal.
 */
export function writeHooks(
  slotPath: string,
  cardId: number,
  port: number,
  _stopEndpoint: string,
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

  // Script reads hook_event_name from stdin to determine the endpoint
  const scriptPath = resolve(__dirname, "../../../scripts/stop-hook.sh");

  settings.hooks = {
    ...(settings.hooks as Record<string, unknown> | undefined),
    Stop: commandHook(cardId, port, scriptPath),
    StopFailure: commandHook(cardId, port, scriptPath),
    Notification: commandHook(cardId, port, scriptPath),
  };

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  logger.info(`Wrote lifecycle hooks to ${settingsPath} (command, cardId=${cardId})`);
}
