import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockDb, createMockEventBus, createMockLogger } from "../helpers/mock-deps";
import { SlotAllocator } from "../../server/domains/execution/slot-allocator";

describe("SlotAllocator", () => {
  let allocator: SlotAllocator;
  let mockDb: ReturnType<typeof createMockDb>;
  let mockEventBus: ReturnType<typeof createMockEventBus>;

  beforeEach(() => {
    mockDb = createMockDb();
    mockEventBus = createMockEventBus();
    allocator = new SlotAllocator({
      db: mockDb as never,
      eventBus: mockEventBus as never,
      logger: createMockLogger() as never,
    });
    vi.clearAllMocks();
  });

  describe("claimSlot()", () => {
    it("claims available slot and returns it", async () => {
      const slot = {
        id: 1,
        repoId: 1,
        path: "/workspace/slot-1",
        portConfig: null,
        envPath: null,
        status: "available",
        claimedByCardId: null,
        createdAt: new Date(),
      };

      // select chain returns available slot
      const selectChain: Record<string, unknown> = {};
      selectChain.from = vi.fn().mockReturnValue(selectChain);
      selectChain.where = vi.fn().mockReturnValue(selectChain);
      selectChain.limit = vi.fn().mockResolvedValue([slot]);
      mockDb.select = vi.fn().mockReturnValue(selectChain);

      // update chain
      const updateChain: Record<string, unknown> = {};
      updateChain.set = vi.fn().mockReturnValue(updateChain);
      updateChain.where = vi.fn().mockResolvedValue(undefined);
      mockDb.update = vi.fn().mockReturnValue(updateChain);

      const result = await allocator.claimSlot(1, 42);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(1);
      expect(result!.status).toBe("claimed");
      expect(result!.claimedByCardId).toBe(42);
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockEventBus.emit).toHaveBeenCalledWith("slot:claimed", { slotId: 1, cardId: 42 });
    });

    it("returns null when no slots available", async () => {
      const selectChain: Record<string, unknown> = {};
      selectChain.from = vi.fn().mockReturnValue(selectChain);
      selectChain.where = vi.fn().mockReturnValue(selectChain);
      selectChain.limit = vi.fn().mockResolvedValue([]);
      mockDb.select = vi.fn().mockReturnValue(selectChain);

      const result = await allocator.claimSlot(1, 42);

      expect(result).toBeNull();
      expect(mockDb.update).not.toHaveBeenCalled();
      expect(mockEventBus.emit).not.toHaveBeenCalled();
    });
  });

  describe("releaseSlot()", () => {
    it("marks slot as available and emits event", async () => {
      const updateChain: Record<string, unknown> = {};
      updateChain.set = vi.fn().mockReturnValue(updateChain);
      updateChain.where = vi.fn().mockResolvedValue(undefined);
      mockDb.update = vi.fn().mockReturnValue(updateChain);

      await allocator.releaseSlot(5);

      expect(mockDb.update).toHaveBeenCalled();
      expect(mockEventBus.emit).toHaveBeenCalledWith("slot:released", { slotId: 5 });
    });
  });

  describe("getSlotForCard()", () => {
    it("returns slot when card has one claimed", async () => {
      const slot = {
        id: 3,
        repoId: 1,
        path: "/workspace/slot-3",
        portConfig: null,
        envPath: null,
        status: "claimed",
        claimedByCardId: 42,
        createdAt: new Date(),
      };

      const selectChain: Record<string, unknown> = {};
      selectChain.from = vi.fn().mockReturnValue(selectChain);
      selectChain.where = vi.fn().mockReturnValue(selectChain);
      selectChain.limit = vi.fn().mockResolvedValue([slot]);
      mockDb.select = vi.fn().mockReturnValue(selectChain);

      const result = await allocator.getSlotForCard(42);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(3);
    });

    it("returns null when card has no slot", async () => {
      const selectChain: Record<string, unknown> = {};
      selectChain.from = vi.fn().mockReturnValue(selectChain);
      selectChain.where = vi.fn().mockReturnValue(selectChain);
      selectChain.limit = vi.fn().mockResolvedValue([]);
      mockDb.select = vi.fn().mockReturnValue(selectChain);

      const result = await allocator.getSlotForCard(99);
      expect(result).toBeNull();
    });
  });
});
