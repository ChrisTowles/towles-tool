import { db } from "../db";
import { cards, workflowRuns } from "../db/schema";
import { eq } from "drizzle-orm";
import { tmuxManager } from "../services/tmux-manager";
import { eventBus } from "../utils/event-bus";
import { logger } from "../utils/logger";

export default defineNitroPlugin(async () => {
  if (!tmuxManager.isAvailable()) {
    logger.info("Session reconnect: tmux not available, skipping");
    return;
  }

  const liveSessions = tmuxManager.listSessions();
  if (liveSessions.length === 0) {
    logger.info("Session reconnect: no orphaned card-* sessions found");
    return;
  }

  logger.info(`Session reconnect: found ${liveSessions.length} card-* session(s)`);

  for (const sessionName of liveSessions) {
    // Extract card ID from session name (card-123)
    const match = sessionName.match(/^card-(\d+)$/);
    if (!match) continue;

    const cardId = Number(match[1]);

    // Fetch card from DB
    const cardRows = await db.select().from(cards).where(eq(cards.id, cardId));
    if (cardRows.length === 0) {
      // Card doesn't exist — kill orphaned session
      logger.warn(`Session reconnect: card ${cardId} not in DB, killing session ${sessionName}`);
      tmuxManager.killSession(sessionName);
      continue;
    }

    const card = cardRows[0]!;

    if (card.status !== "running") {
      // Card isn't in_progress — kill stale session
      logger.warn(
        `Session reconnect: card ${cardId} status is "${card.status}", killing stale session`,
      );
      tmuxManager.killSession(sessionName);
      continue;
    }

    // Card is running and session exists — resume capture
    if (tmuxManager.sessionExists(sessionName)) {
      logger.info(`Session reconnect: resuming capture for card ${cardId}`);
      tmuxManager.startCapture(sessionName, (output) => {
        eventBus.emit("agent:output", { cardId, content: output });
      });
    } else {
      // Session was listed but died between list and check — mark failed
      logger.warn(`Session reconnect: session ${sessionName} died, marking card ${cardId} failed`);
      await db
        .update(cards)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(cards.id, cardId));

      await db
        .update(workflowRuns)
        .set({ status: "failed", endedAt: new Date() })
        .where(eq(workflowRuns.cardId, cardId));

      eventBus.emit("card:status-changed", { cardId, status: "failed" });
    }
  }

  // Check for cards marked running but with no live tmux session
  const runningCards = await db.select().from(cards).where(eq(cards.status, "running"));

  for (const card of runningCards) {
    const sessionName = `card-${card.id}`;
    if (!liveSessions.includes(sessionName)) {
      logger.warn(
        `Session reconnect: card ${card.id} is running but no tmux session, marking failed`,
      );
      await db
        .update(cards)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(cards.id, card.id));

      await db
        .update(workflowRuns)
        .set({ status: "failed", endedAt: new Date() })
        .where(eq(workflowRuns.cardId, card.id));

      eventBus.emit("card:status-changed", { cardId: card.id, status: "failed" });
    }
  }

  logger.info("Session reconnect: reconciliation complete");
});
