import { db } from "../shared/db";
import { cards, workspaceSlots } from "../shared/db/schema";
import { eq, and } from "drizzle-orm";
import { agentExecutor } from "../domains/execution/agent-executor";
import { eventBus } from "../shared/event-bus";
import { logger } from "../utils/logger";
import { cardService } from "../domains/cards/card-service";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { CardService } from "../domains/cards/card-service";

export interface QueueManagerDeps {
  db: BetterSQLite3Database<Record<string, unknown>>;
  eventBus: {
    on: (event: string, handler: (...args: never[]) => void) => void;
    emit: (event: string, data: unknown) => void;
  };
  logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  agentExecutor: { startExecution: (cardId: number) => Promise<void> };
  cardService: CardService;
  maxConcurrent?: number;
}

export function createQueueManager(deps: QueueManagerDeps): void {
  const MAX_CONCURRENT = deps.maxConcurrent ?? (Number(process.env.MAX_CONCURRENT_AGENTS) || 3);

  async function tryAutoStartNext(slot: { id: number; repoId: number | null }): Promise<boolean> {
    const runningCards = await deps.db.select().from(cards).where(eq(cards.status, "running"));

    if (runningCards.length >= MAX_CONCURRENT) {
      deps.logger.info(
        `Queue: ${runningCards.length}/${MAX_CONCURRENT} agents running, skipping auto-start`,
      );
      return false;
    }

    let queued = await deps.db
      .select()
      .from(cards)
      .where(and(eq(cards.repoId, slot.repoId), eq(cards.status, "queued")))
      .orderBy(cards.position)
      .limit(1);

    if (queued.length === 0) {
      queued = await deps.db
        .select()
        .from(cards)
        .where(
          and(eq(cards.repoId, slot.repoId), eq(cards.column, "ready"), eq(cards.status, "idle")),
        )
        .orderBy(cards.position)
        .limit(1);
    }

    if (queued.length === 0) {
      deps.logger.info(`Queue: no queued or ready cards for repo ${slot.repoId}`);
      return false;
    }

    const nextCard = queued[0]!;
    const isReadyCard = nextCard.status === "idle" && nextCard.column === "ready";
    deps.logger.info(
      `Queue: auto-starting card ${nextCard.id} (${isReadyCard ? "ready/idle" : "queued"}) for repo ${slot.repoId}`,
    );

    await deps.db
      .update(workspaceSlots)
      .set({ status: "claimed", claimedByCardId: nextCard.id })
      .where(eq(workspaceSlots.id, slot.id));

    await deps.db
      .update(cards)
      .set({ column: "in_progress", updatedAt: new Date() })
      .where(eq(cards.id, nextCard.id));

    deps.eventBus.emit("card:moved", {
      cardId: nextCard.id,
      fromColumn: nextCard.column,
      toColumn: "in_progress",
    });

    if (isReadyCard) {
      await deps.cardService.logEvent(
        nextCard.id,
        "auto_started",
        `Auto-promoted from ready column (slot ${slot.id} became available)`,
      );
    }

    deps.agentExecutor.startExecution(nextCard.id).catch((err) => {
      deps.logger.error(`Queue: failed to start card ${nextCard.id}:`, err);
      deps.eventBus.emit("card:status-changed", { cardId: nextCard.id, status: "failed" });
    });

    return true;
  }

  deps.eventBus.on("slot:released", async (data: { slotId: number }) => {
    try {
      const [slot] = await deps.db
        .select()
        .from(workspaceSlots)
        .where(eq(workspaceSlots.id, data.slotId));
      if (!slot) return;
      await tryAutoStartNext(slot);
    } catch (err) {
      deps.logger.error("Queue: error processing slot:released:", err);
    }
  });

  deps.eventBus.on("card:status-changed", async (data: { cardId: number; status: string }) => {
    if (data.status !== "review_ready" && data.status !== "done" && data.status !== "failed") {
      return;
    }

    try {
      const runningCards = await deps.db.select().from(cards).where(eq(cards.status, "running"));

      if (runningCards.length >= MAX_CONCURRENT) return;

      const availableSlots = await deps.db
        .select()
        .from(workspaceSlots)
        .where(eq(workspaceSlots.status, "available"));

      let started = 0;
      for (const slot of availableSlots) {
        if (runningCards.length + started >= MAX_CONCURRENT) break;

        const didStart = await tryAutoStartNext(slot);
        if (didStart) started++;
      }
    } catch (err) {
      deps.logger.error("Queue: error processing card:status-changed for auto-start:", err);
    }
  });

  deps.logger.info(`Queue manager active (max concurrent: ${MAX_CONCURRENT})`);
}

export default defineNitroPlugin(() => {
  createQueueManager({ db, eventBus, logger, agentExecutor, cardService });
});
