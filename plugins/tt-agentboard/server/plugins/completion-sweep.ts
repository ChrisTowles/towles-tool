import { db as defaultDb } from "../shared/db";
import { cards } from "../shared/db/schema";
import { eq } from "drizzle-orm";
import { tmuxManager as defaultTmuxManager } from "../domains/infra/tmux-manager";
import { logger as defaultLogger } from "../utils/logger";

const SWEEP_INTERVAL_MS = 30_000;
// Processes that indicate the agent or its setup is still active — don't sweep these
const AGENT_COMMANDS = new Set(["node", "tt", "claude", "tsx", "pnpm", "npm", "bun", "git"]);

export interface CompletionSweepDeps {
  tmuxManager: {
    listSessions: () => string[];
    getPaneCommand: (name: string) => string | null;
  };
  db: typeof defaultDb;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  triggerComplete: (cardId: number) => Promise<void>;
}

export function createCompletionSweep(deps: CompletionSweepDeps) {
  async function sweep() {
    const sessions = deps.tmuxManager.listSessions();
    if (sessions.length === 0) return;

    const runningCards = await deps.db.select().from(cards).where(eq(cards.status, "running"));

    const runningById = new Map(runningCards.map((c) => [c.id, c]));

    for (const sessionName of sessions) {
      const match = sessionName.match(/^card-(\d+)$/);
      if (!match) continue;
      const cardId = Number(match[1]);

      const card = runningById.get(cardId);
      if (!card) continue;

      const cmd = deps.tmuxManager.getPaneCommand(sessionName);
      if (!cmd) continue;

      // If foreground process is a shell (not an agent command), agent finished
      if (!AGENT_COMMANDS.has(cmd)) {
        deps.logger.warn(
          `Completion sweep: card ${cardId} session idle (${cmd}), triggering complete`,
        );
        try {
          await deps.triggerComplete(cardId);
        } catch (err) {
          deps.logger.warn(`Completion sweep: failed to complete card ${cardId}:`, err);
        }
      }
    }
  }

  return { sweep };
}

export default defineNitroPlugin(() => {
  async function triggerComplete(cardId: number) {
    await $fetch(`/api/agents/${cardId}/complete`, { method: "POST", body: {} });
  }

  const { sweep } = createCompletionSweep({
    tmuxManager: defaultTmuxManager,
    db: defaultDb,
    logger: defaultLogger,
    triggerComplete,
  });

  // Initial sweep after startup (give agents time to register)
  setTimeout(sweep, 10_000);

  // Periodic sweep
  setInterval(sweep, SWEEP_INTERVAL_MS);

  defaultLogger.info(`Completion sweep active (interval: ${SWEEP_INTERVAL_MS}ms)`);
});
