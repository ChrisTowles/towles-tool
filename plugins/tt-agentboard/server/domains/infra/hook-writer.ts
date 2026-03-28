import {
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { logger } from "../../utils/logger";

/** Source script lives next to the compiled output — find it relative to this file or the plugin root */
function findScriptSource(): string {
  // Walk up from this file to find the plugin root (contains scripts/)
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "scripts", "stop-hook.sh");
    if (existsSync(candidate)) return candidate;
    dir = resolve(dir, "..");
  }
  // Fallback: relative to CWD (dev mode)
  return resolve(process.cwd(), "scripts", "stop-hook.sh");
}

function commandHook(cardId: number, port: number, stopEndpoint: string, scriptPath: string) {
  return [
    {
      matcher: "",
      hooks: [
        {
          type: "command",
          command: `AGENTBOARD_CARD_ID=${cardId} AGENTBOARD_PORT=${port} AGENTBOARD_STOP_ENDPOINT=${stopEndpoint} ${scriptPath}`,
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
 * Copies the retry script into the slot's .claude/ dir so it works regardless
 * of how Nitro resolves __dirname at build time.
 *
 * Uses command hooks (not HTTP hooks) so that transient server restarts
 * don't silently lose the completion signal.
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

  // Copy the retry script into the slot so path resolution is always reliable
  const scriptDest = resolve(claudeDir, "stop-hook.sh");
  try {
    const source = findScriptSource();
    copyFileSync(source, scriptDest);
    chmodSync(scriptDest, 0o755);
  } catch (err) {
    logger.warn(`Could not copy stop-hook.sh to ${scriptDest}:`, err);
  }

  settings.hooks = {
    ...(settings.hooks as Record<string, unknown> | undefined),
    Stop: commandHook(cardId, port, stopEndpoint, scriptDest),
    StopFailure: commandHook(cardId, port, stopEndpoint, scriptDest),
    Notification: commandHook(cardId, port, stopEndpoint, scriptDest),
  };

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  logger.info(
    `Wrote lifecycle hooks to ${settingsPath} (command, cardId=${cardId}, endpoint=${stopEndpoint})`,
  );
}
