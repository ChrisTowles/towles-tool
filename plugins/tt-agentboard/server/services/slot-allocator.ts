import { db } from "../db";
import { workspaceSlots } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { eventBus } from "../utils/event-bus";
import { logger } from "../utils/logger";

export class SlotAllocator {
  /** Find and claim an available slot for a repo */
  async claimSlot(
    repoId: number,
    cardId: number,
  ): Promise<typeof workspaceSlots.$inferSelect | null> {
    const available = await db
      .select()
      .from(workspaceSlots)
      .where(and(eq(workspaceSlots.repoId, repoId), eq(workspaceSlots.status, "available")))
      .limit(1);

    if (available.length === 0) {
      logger.warn(`No available slot for repo ${repoId}, card ${cardId}`);
      return null;
    }

    const slot = available[0]!;
    await db
      .update(workspaceSlots)
      .set({
        status: "claimed",
        claimedByCardId: cardId,
      })
      .where(eq(workspaceSlots.id, slot.id));

    eventBus.emit("slot:claimed", { slotId: slot.id, cardId });
    logger.info(`Slot ${slot.id} claimed by card ${cardId}`);

    return {
      ...slot,
      status: "claimed" as const,
      claimedByCardId: cardId,
    } as typeof workspaceSlots.$inferSelect;
  }

  /** Release a slot when work is done */
  async releaseSlot(slotId: number): Promise<void> {
    await db
      .update(workspaceSlots)
      .set({
        status: "available",
        claimedByCardId: null,
      })
      .where(eq(workspaceSlots.id, slotId));

    eventBus.emit("slot:released", { slotId });
    logger.info(`Slot ${slotId} released`);
  }

  /** Get the slot currently claimed by a card */
  async getSlotForCard(cardId: number): Promise<typeof workspaceSlots.$inferSelect | null> {
    const result = await db
      .select()
      .from(workspaceSlots)
      .where(eq(workspaceSlots.claimedByCardId, cardId))
      .limit(1);

    return result[0] ?? null;
  }
}

export const slotAllocator = new SlotAllocator();
