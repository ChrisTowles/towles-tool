import { db } from "../../shared/db";
import { workspaceSlots } from "../../shared/db/schema";
import { eq, and } from "drizzle-orm";
import { eventBus } from "../../shared/event-bus";
import { logger } from "../../utils/logger";
import { slotPreparer as defaultSlotPreparer } from "./slot-preparer";
import type { SlotPreparer } from "./slot-preparer";

export interface SlotAllocatorDeps {
  db: typeof db;
  eventBus: typeof eventBus;
  logger: typeof logger;
  slotPreparer: SlotPreparer;
}

export class SlotAllocator {
  private deps: SlotAllocatorDeps;

  constructor(deps: Partial<SlotAllocatorDeps> = {}) {
    this.deps = { db, eventBus, logger, slotPreparer: defaultSlotPreparer, ...deps };
  }

  /** Find and claim an available slot for a repo */
  async claimSlot(
    repoId: number,
    cardId: number,
  ): Promise<typeof workspaceSlots.$inferSelect | null> {
    const available = await this.deps.db
      .select()
      .from(workspaceSlots)
      .where(and(eq(workspaceSlots.repoId, repoId), eq(workspaceSlots.status, "available")))
      .limit(1);

    if (available.length === 0) {
      this.deps.logger.warn(`No available slot for repo ${repoId}, card ${cardId}`);
      return null;
    }

    const slot = available[0]!;
    await this.deps.db
      .update(workspaceSlots)
      .set({
        status: "claimed",
        claimedByCardId: cardId,
      })
      .where(eq(workspaceSlots.id, slot.id));

    this.deps.eventBus.emit("slot:claimed", { slotId: slot.id, cardId });
    this.deps.logger.info(`Slot ${slot.id} claimed by card ${cardId}`);

    return {
      ...slot,
      status: "claimed" as const,
      claimedByCardId: cardId,
    } as typeof workspaceSlots.$inferSelect;
  }

  /** Release a slot when work is done, then reset it for the next use */
  async releaseSlot(slotId: number): Promise<void> {
    // Look up the slot path before releasing
    const slotRows = await this.deps.db
      .select()
      .from(workspaceSlots)
      .where(eq(workspaceSlots.id, slotId))
      .limit(1);
    const slotPath = slotRows[0]?.path;

    await this.deps.db
      .update(workspaceSlots)
      .set({
        status: "available",
        claimedByCardId: null,
      })
      .where(eq(workspaceSlots.id, slotId));

    this.deps.eventBus.emit("slot:released", { slotId });
    this.deps.logger.info(`Slot ${slotId} released`);

    // Reset slot in the background: sync to main + install deps
    if (slotPath) {
      this.deps.slotPreparer.reset(slotPath).catch((err) => {
        this.deps.logger.error(`Slot ${slotId} reset failed:`, err);
      });
    }
  }

  /** Get the slot currently claimed by a card */
  async getSlotForCard(cardId: number): Promise<typeof workspaceSlots.$inferSelect | null> {
    const result = await this.deps.db
      .select()
      .from(workspaceSlots)
      .where(eq(workspaceSlots.claimedByCardId, cardId))
      .limit(1);

    return result[0] ?? null;
  }
}

export const slotAllocator = new SlotAllocator();
