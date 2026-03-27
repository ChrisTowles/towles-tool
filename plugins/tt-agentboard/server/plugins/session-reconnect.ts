import { db } from "../db";
import { cards, workflowRuns } from "../db/schema";
import { eq, inArray } from "drizzle-orm";
import { tmuxManager } from "../services/tmux-manager";
import { eventBus } from "../utils/event-bus";
import { logger } from "../utils/logger";
import { logCardEvent } from "../utils/card-events";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

export interface SessionReconnectDeps {
  db: BetterSQLite3Database<Record<string, unknown>>;
  tmuxManager: {
    isAvailable: () => boolean;
    listSessions: () => string[];
    sessionExists: (name: string) => boolean;
    startCapture: (name: string, onOutput: (output: string) => void) => void;
    killSession: (name: string) => void;
  };
  eventBus: { emit: (event: string, data: unknown) => void };
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  logCardEvent: (cardId: number, event: string, detail?: string) => Promise<void>;
}

export async function createSessionReconnect(deps: SessionReconnectDeps): Promise<void> {
  if (!deps.tmuxManager.isAvailable()) {
    deps.logger.info("Session reconnect: tmux not available, skipping");
    return;
  }

  const liveSessions = deps.tmuxManager.listSessions();
  if (liveSessions.length === 0) {
    deps.logger.info("Session reconnect: no orphaned card-* sessions found");
    return;
  }

  deps.logger.info(`Session reconnect: found ${liveSessions.length} card-* session(s)`);

  const sessionCardIds: number[] = [];
  const sessionMap = new Map<number, string>();
  for (const sessionName of liveSessions) {
    const match = sessionName.match(/^card-(\d+)$/);
    if (!match) continue;
    const cardId = Number(match[1]);
    sessionCardIds.push(cardId);
    sessionMap.set(cardId, sessionName);
  }

  const cardRows =
    sessionCardIds.length > 0
      ? await deps.db.select().from(cards).where(inArray(cards.id, sessionCardIds))
      : [];
  const cardById = new Map(cardRows.map((c) => [c.id, c]));

  for (const [cardId, sessionName] of sessionMap) {
    const card = cardById.get(cardId);

    if (!card) {
      deps.logger.warn(
        `Session reconnect: card ${cardId} not in DB, killing session ${sessionName}`,
      );
      deps.tmuxManager.killSession(sessionName);
      continue;
    }

    if (card.status !== "running") {
      deps.logger.warn(
        `Session reconnect: card ${cardId} status is "${card.status}", killing stale session`,
      );
      deps.tmuxManager.killSession(sessionName);
      await deps.logCardEvent(
        cardId,
        "tmux_session_orphaned_killed",
        `session=${sessionName}, status=${card.status}`,
      );
      continue;
    }

    if (deps.tmuxManager.sessionExists(sessionName)) {
      deps.logger.info(`Session reconnect: resuming capture for card ${cardId}`);
      await deps.logCardEvent(cardId, "tmux_session_reconnected", `session=${sessionName}`);
      deps.tmuxManager.startCapture(sessionName, (output) => {
        deps.eventBus.emit("agent:output", { cardId, content: output });
      });
    } else {
      deps.logger.warn(
        `Session reconnect: session ${sessionName} died, marking card ${cardId} failed`,
      );
      await deps.db
        .update(cards)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(cards.id, cardId));

      await deps.db
        .update(workflowRuns)
        .set({ status: "failed", endedAt: new Date() })
        .where(eq(workflowRuns.cardId, cardId));

      await deps.logCardEvent(
        cardId,
        "agent_failed",
        `session ${sessionName} died between list and check`,
      );
      deps.eventBus.emit("card:status-changed", { cardId, status: "failed" });
    }
  }

  const runningCards = await deps.db.select().from(cards).where(eq(cards.status, "running"));

  for (const card of runningCards) {
    const sessionName = `card-${card.id}`;
    if (!liveSessions.includes(sessionName)) {
      deps.logger.warn(
        `Session reconnect: card ${card.id} is running but no tmux session, marking failed`,
      );
      await deps.logCardEvent(card.id, "agent_failed", "session not found on restart");
      await deps.db
        .update(cards)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(cards.id, card.id));

      await deps.db
        .update(workflowRuns)
        .set({ status: "failed", endedAt: new Date() })
        .where(eq(workflowRuns.cardId, card.id));

      deps.eventBus.emit("card:status-changed", { cardId: card.id, status: "failed" });
    }
  }

  deps.logger.info("Session reconnect: reconciliation complete");
}

export default defineNitroPlugin(async () => {
  await createSessionReconnect({ db, tmuxManager, eventBus, logger, logCardEvent });
});
