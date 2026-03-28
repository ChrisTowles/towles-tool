import { db as defaultDb } from "../../shared/db";
import { cards, cardEvents, cardDependencies } from "../../shared/db/schema";
import { eq, inArray } from "drizzle-orm";
import { eventBus as defaultEventBus } from "../../shared/event-bus";
import { logger as defaultLogger } from "../../utils/logger";
import type { CardStatus, Column } from "./types";

export interface CardServiceDeps {
  db: typeof defaultDb;
  eventBus: typeof defaultEventBus;
  logger: typeof defaultLogger;
}

/**
 * Centralized service for all card state transitions.
 * All card status updates, column moves, and event logging go through here.
 */
export class CardService {
  private deps: CardServiceDeps;

  constructor(deps: Partial<CardServiceDeps> = {}) {
    this.deps = {
      db: defaultDb,
      eventBus: defaultEventBus,
      logger: defaultLogger,
      ...deps,
    };
  }

  /** Update card status + updatedAt, emit card:status-changed */
  async updateStatus(cardId: number, status: CardStatus): Promise<void> {
    await this.deps.db
      .update(cards)
      .set({ status, updatedAt: new Date() })
      .where(eq(cards.id, cardId));

    this.deps.eventBus.emit("card:status-changed", { cardId, status });
  }

  /** Fetch card to get fromColumn, update column + updatedAt, emit card:moved */
  async moveToColumn(cardId: number, toColumn: Column): Promise<void> {
    const rows = await this.deps.db.select().from(cards).where(eq(cards.id, cardId));
    if (rows.length === 0) {
      throw new Error(`Card ${cardId} not found`);
    }
    const fromColumn = rows[0]!.column ?? "backlog";

    await this.deps.db
      .update(cards)
      .set({ column: toColumn, updatedAt: new Date() })
      .where(eq(cards.id, cardId));

    this.deps.eventBus.emit("card:moved", { cardId, fromColumn: fromColumn as Column, toColumn });
  }

  /** Mark card as failed, optionally log a reason */
  async markFailed(cardId: number, reason?: string): Promise<void> {
    await this.updateStatus(cardId, "failed");
    if (reason) {
      await this.logEvent(cardId, "failed", reason);
    }
  }

  /** Mark card complete: status=review_ready, column=review */
  async markComplete(cardId: number): Promise<void> {
    const rows = await this.deps.db
      .select({ column: cards.column })
      .from(cards)
      .where(eq(cards.id, cardId));
    const fromColumn = (rows[0]?.column ?? "in_progress") as Column;

    await this.deps.db
      .update(cards)
      .set({ status: "review_ready", column: "review", updatedAt: new Date() })
      .where(eq(cards.id, cardId));

    this.deps.eventBus.emit("card:status-changed", {
      cardId,
      status: "review_ready" as CardStatus,
    });
    this.deps.eventBus.emit("card:moved", {
      cardId,
      fromColumn,
      toColumn: "review" as Column,
    });
  }

  /** Insert a row into the cardEvents table */
  async logEvent(cardId: number, event: string, detail?: string): Promise<void> {
    await this.deps.db.insert(cardEvents).values({ cardId, event, detail });
  }

  /** Batch-fetch dependency IDs for a set of cards */
  async getDepsMap(cardIds: number[]): Promise<Map<number, number[]>> {
    const map = new Map<number, number[]>();
    if (cardIds.length === 0) return map;

    const deps = await this.deps.db
      .select()
      .from(cardDependencies)
      .where(inArray(cardDependencies.cardId, cardIds));

    for (const dep of deps) {
      const existing = map.get(dep.cardId) ?? [];
      existing.push(dep.dependsOnCardId);
      map.set(dep.cardId, existing);
    }
    return map;
  }

  /**
   * After a card completes, find all blocked cards that depended on it
   * and check if their remaining dependencies are all met (done).
   * Returns the IDs of cards that were unblocked and moved to ready.
   */
  async resolveDependencies(completedCardId: number): Promise<number[]> {
    const depRows = await this.deps.db
      .select({ cardId: cardDependencies.cardId })
      .from(cardDependencies)
      .where(eq(cardDependencies.dependsOnCardId, completedCardId));

    if (depRows.length === 0) return [];

    const dependentCardIds = depRows.map((r) => r.cardId);

    const blockedCards = await this.deps.db
      .select()
      .from(cards)
      .where(inArray(cards.id, dependentCardIds));

    const blocked = blockedCards.filter((c) => c.status === "blocked");
    if (blocked.length === 0) return [];

    // Batch-load all deps for blocked cards + check which dep cards are done
    const allDeps = await this.getDepsMap(blocked.map((c) => c.id));
    const allDepIds = [...new Set([...allDeps.values()].flat())];
    const depCardStatuses = new Map<number, string>();
    if (allDepIds.length > 0) {
      const depCards = await this.deps.db
        .select({ id: cards.id, status: cards.status })
        .from(cards)
        .where(inArray(cards.id, allDepIds));
      for (const c of depCards) {
        depCardStatuses.set(c.id, c.status);
      }
    }

    const unblockedIds: number[] = [];

    for (const card of blocked) {
      const deps = allDeps.get(card.id) ?? [];
      const allMet =
        deps.length > 0 && deps.every((depId) => depCardStatuses.get(depId) === "done");

      if (allMet) {
        await this.deps.db
          .update(cards)
          .set({ column: "ready", status: "idle", updatedAt: new Date() })
          .where(eq(cards.id, card.id));

        unblockedIds.push(card.id);
        this.deps.logger.info(`Card ${card.id} unblocked — all dependencies met, moved to ready`);
      }
    }

    return unblockedIds;
  }
}

export const cardService = new CardService();
