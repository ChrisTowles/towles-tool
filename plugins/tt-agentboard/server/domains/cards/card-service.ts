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
    await this.updateStatus(cardId, "review_ready");
    await this.moveToColumn(cardId, "review");
  }

  /** Insert a row into the cardEvents table */
  async logEvent(cardId: number, event: string, detail?: string): Promise<void> {
    await this.deps.db.insert(cardEvents).values({ cardId, event, detail });
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

    const unblockedIds: number[] = [];

    for (const card of blockedCards) {
      if (card.status !== "blocked") continue;

      const deps = await this.getDeps(card.id);
      const allMet = await this.allDepsMet(deps);

      if (allMet) {
        await this.deps.db
          .update(cards)
          .set({
            column: "ready",
            status: "idle",
            updatedAt: new Date(),
          })
          .where(eq(cards.id, card.id));

        unblockedIds.push(card.id);
        this.deps.logger.info(`Card ${card.id} unblocked — all dependencies met, moved to ready`);
      }
    }

    return unblockedIds;
  }

  /** Get dependency card IDs for a card */
  private async getDeps(cardId: number): Promise<number[]> {
    const rows = await this.deps.db
      .select({ dependsOnCardId: cardDependencies.dependsOnCardId })
      .from(cardDependencies)
      .where(eq(cardDependencies.cardId, cardId));
    return rows.map((r) => r.dependsOnCardId);
  }

  /** Check if all dependency card IDs are in 'done' status */
  private async allDepsMet(depIds: number[]): Promise<boolean> {
    if (depIds.length === 0) return true;

    const depCards = await this.deps.db
      .select({ id: cards.id, status: cards.status })
      .from(cards)
      .where(inArray(cards.id, depIds));

    if (depCards.length !== depIds.length) return false;
    return depCards.every((c) => c.status === "done");
  }
}

export const cardService = new CardService();
