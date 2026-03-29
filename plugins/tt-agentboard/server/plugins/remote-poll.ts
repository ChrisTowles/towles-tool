import { db as defaultDb } from "../shared/db";
import { workflowRuns } from "../shared/db/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import { logger as defaultLogger } from "../utils/logger";
import { execSync as defaultExecSync } from "node:child_process";
import { cardService as defaultCardService } from "../domains/cards/card-service";
import { eventBus as defaultEventBus } from "../shared/event-bus";
import type { CardService } from "../domains/cards/card-service";

export interface RemotePollDeps {
  db: typeof defaultDb;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  cardService: CardService;
  eventBus: { emit: (event: string, data: unknown) => void };
  execSync: typeof defaultExecSync;
  pollIntervalMs: number;
}

export function checkRemoteSessionStatus(
  sessionId: string,
  execSync: typeof defaultExecSync,
): "running" | "completed" | "failed" | "unknown" {
  try {
    const output = execSync(`claude sessions list --json`, {
      encoding: "utf-8",
      timeout: 15_000,
    });
    const sessions = JSON.parse(output) as Array<{ id: string; status: string }>;
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return "unknown";
    if (session.status === "completed" || session.status === "done") return "completed";
    if (session.status === "failed" || session.status === "error") return "failed";
    return "running";
  } catch {
    return "unknown";
  }
}

export async function pollRemoteSessions(deps: RemotePollDeps): Promise<void> {
  const running = await deps.db
    .select()
    .from(workflowRuns)
    .where(and(isNotNull(workflowRuns.remoteSessionId), eq(workflowRuns.status, "running")));

  if (running.length === 0) return;

  deps.logger.info(`Remote poll: checking ${running.length} remote session(s)`);

  for (const run of running) {
    const status = checkRemoteSessionStatus(run.remoteSessionId!, deps.execSync);

    if (status === "completed") {
      await deps.db
        .update(workflowRuns)
        .set({ status: "completed", endedAt: new Date() })
        .where(eq(workflowRuns.id, run.id));
      await deps.cardService.markComplete(run.cardId);
      await deps.cardService.logEvent(
        run.cardId,
        "remote_session_completed",
        `sessionId=${run.remoteSessionId}`,
      );
      deps.eventBus.emit("workflow:completed", { cardId: run.cardId, status: "completed" });
      deps.logger.info(`Remote session ${run.remoteSessionId} completed for card ${run.cardId}`);
    } else if (status === "failed") {
      await deps.db
        .update(workflowRuns)
        .set({ status: "failed", endedAt: new Date() })
        .where(eq(workflowRuns.id, run.id));
      await deps.cardService.updateStatus(run.cardId, "failed");
      await deps.cardService.logEvent(
        run.cardId,
        "remote_session_failed",
        `sessionId=${run.remoteSessionId}`,
      );
      deps.logger.info(`Remote session ${run.remoteSessionId} failed for card ${run.cardId}`);
    }
    // "running" and "unknown" — no action, check again next poll
  }
}

export default defineNitroPlugin(() => {
  const deps: RemotePollDeps = {
    db: defaultDb,
    logger: defaultLogger,
    cardService: defaultCardService,
    eventBus: defaultEventBus,
    execSync: defaultExecSync,
    pollIntervalMs: 30_000,
  };

  const interval = setInterval(() => {
    pollRemoteSessions(deps).catch((err) => {
      defaultLogger.warn(`Remote poll error: ${err}`);
    });
  }, deps.pollIntervalMs);

  // Nitro doesn't provide cleanup hooks natively, but the interval
  // will be cleared when the process exits
  if (typeof globalThis !== "undefined") {
    (globalThis as Record<string, unknown>).__remotePollInterval = interval;
  }
});
