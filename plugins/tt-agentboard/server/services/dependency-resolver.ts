import { db } from "../db";
import { cards } from "../db/schema";
import { eq, inArray } from "drizzle-orm";
import { logger } from "../utils/logger";

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
   * Parse the dependsOn field (comma-separated card IDs) into an array of numbers.
   */
  parseDeps(dependsOn: string | null): number[] {
    if (!dependsOn) return [];
    return dependsOn
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n) && n > 0);
  }

  /**
   * After a card completes, find all blocked cards that depended on it
   * and check if their remaining dependencies are all met (done).
   * Returns the IDs of cards that were unblocked and moved to 'ready'.
   */
  async resolveAfterCompletion(completedCardId: number): Promise<number[]> {
    // Find all cards with status 'blocked' that reference the completed card in dependsOn
    const blockedCards = await this.deps.db.select().from(cards).where(eq(cards.status, "blocked"));

    const unblockedIds: number[] = [];

    for (const card of blockedCards) {
      const deps = this.parseDeps(card.dependsOn);
      if (!deps.includes(completedCardId)) continue;

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
