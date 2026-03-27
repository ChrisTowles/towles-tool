import { db } from "../../shared/db";
import { cards, cardDependencies } from "../../shared/db/schema";
import { eq, inArray } from "drizzle-orm";
import { logger } from "../../utils/logger";

export interface DependencyResolverDeps {
  db: typeof db;
  logger: typeof logger;
}

/**
 * Resolves card dependencies. When a card completes, checks if any blocked
 * cards now have all dependencies met and moves them to 'ready'.
 */
export class DependencyResolver {
  private deps: DependencyResolverDeps;

  constructor(deps: Partial<DependencyResolverDeps> = {}) {
    this.deps = { db, logger, ...deps };
  }

  /**
   * Get the dependency card IDs for a given card from the cardDependencies table.
   */
  async getDeps(cardId: number): Promise<number[]> {
    const rows = await this.deps.db
      .select({ dependsOnCardId: cardDependencies.dependsOnCardId })
      .from(cardDependencies)
      .where(eq(cardDependencies.cardId, cardId));
    return rows.map((r) => r.dependsOnCardId);
  }

  /**
   * After a card completes, find all blocked cards that depended on it
   * and check if their remaining dependencies are all met (done).
   * Returns the IDs of cards that were unblocked and moved to 'ready'.
   */
  async resolveAfterCompletion(completedCardId: number): Promise<number[]> {
    // Find all cards that depend on the completed card via the join table
    const depRows = await this.deps.db
      .select({ cardId: cardDependencies.cardId })
      .from(cardDependencies)
      .where(eq(cardDependencies.dependsOnCardId, completedCardId));

    if (depRows.length === 0) return [];

    const dependentCardIds = depRows.map((r) => r.cardId);

    // Fetch only the blocked ones among those dependents
    const blockedCards = await this.deps.db
      .select()
      .from(cards)
      .where(inArray(cards.id, dependentCardIds));

    const unblockedIds: number[] = [];

    for (const card of blockedCards) {
      if (card.status !== "blocked") continue;

      // Get all deps for this card
      const deps = await this.getDeps(card.id);

      // Check if ALL dependencies are now done
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

  /**
   * Check if all dependency card IDs are in 'done' status.
   */
  private async allDepsMet(depIds: number[]): Promise<boolean> {
    if (depIds.length === 0) return true;

    const depCards = await this.deps.db
      .select({ id: cards.id, status: cards.status })
      .from(cards)
      .where(inArray(cards.id, depIds));

    // All deps must exist and be done
    if (depCards.length !== depIds.length) return false;
    return depCards.every((c) => c.status === "done");
  }
}

export const dependencyResolver = new DependencyResolver();
