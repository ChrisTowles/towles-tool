import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { SlotAllocator } from "../../server/domains/execution/slot-allocator";
import { workspaceSlots } from "../../server/shared/db/schema";
import {
  db,
  cleanDb,
  seedRepo,
  createTestEventBus,
  createNoopLogger,
  findEvents,
  seedSlot,
} from "../helpers/test-db";

describe("SlotAllocator", () => {
  let allocator: SlotAllocator;
  let bus: ReturnType<typeof createTestEventBus>["bus"];
  let events: ReturnType<typeof createTestEventBus>["events"];
  let repoId: number;

  beforeEach(async () => {
    cleanDb();
    const repo = await seedRepo();
    repoId = repo.id;

    ({ bus, events } = createTestEventBus());
    allocator = new SlotAllocator({
      db,
      eventBus: bus,
      logger: createNoopLogger() as never,
      slotPreparer: { reset: async () => ({ events: [], depsInstalled: false, packageManager: null }) } as never,
    });
  });

  describe("claimSlot()", () => {
    it("claims available slot and returns it", async () => {
      const slot = await seedSlot(repoId, { path: "/workspace/slot-1" });

      const result = await allocator.claimSlot(repoId, 42);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(slot.id);
      expect(result!.status).toBe("claimed");
      expect(result!.claimedByCardId).toBe(42);

      // Verify DB was updated
      const [dbSlot] = await db.select().from(workspaceSlots).where(eq(workspaceSlots.id, slot.id));
      expect(dbSlot.status).toBe("claimed");
      expect(dbSlot.claimedByCardId).toBe(42);

      const claimedEvents = findEvents(events, "slot:claimed");
      expect(claimedEvents).toHaveLength(1);
      expect(claimedEvents[0].data).toEqual({ slotId: slot.id, cardId: 42 });
    });

    it("returns null when no slots available", async () => {
      const result = await allocator.claimSlot(repoId, 42);

      expect(result).toBeNull();
      expect(findEvents(events, "slot:claimed")).toHaveLength(0);
    });
  });

  describe("releaseSlot()", () => {
    it("marks slot as available and emits event", async () => {
      const slot = await seedSlot(repoId, {
        path: "/workspace/slot-1",
        status: "claimed",
        claimedByCardId: 42,
      });

      await allocator.releaseSlot(slot.id);

      const [dbSlot] = await db.select().from(workspaceSlots).where(eq(workspaceSlots.id, slot.id));
      expect(dbSlot.status).toBe("available");
      expect(dbSlot.claimedByCardId).toBeNull();

      const releasedEvents = findEvents(events, "slot:released");
      expect(releasedEvents).toHaveLength(1);
      expect(releasedEvents[0].data).toEqual({ slotId: slot.id });
    });
  });

  describe("getSlotForCard()", () => {
    it("returns slot when card has one claimed", async () => {
      const slot = await seedSlot(repoId, {
        path: "/workspace/slot-3",
        status: "claimed",
        claimedByCardId: 42,
      });

      const result = await allocator.getSlotForCard(42);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(slot.id);
    });

    it("returns null when card has no slot", async () => {
      const result = await allocator.getSlotForCard(99);
      expect(result).toBeNull();
    });
  });
});
