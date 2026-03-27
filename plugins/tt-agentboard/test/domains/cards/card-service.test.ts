import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockDb, createMockEventBus, createMockLogger } from "../../helpers/mock-deps";
import { CardService } from "../../../server/domains/cards/card-service";

describe("CardService", () => {
  let service: CardService;
  let mockDb: ReturnType<typeof createMockDb>;
  let mockEventBus: ReturnType<typeof createMockEventBus>;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    mockEventBus = createMockEventBus();
    mockLogger = createMockLogger();
    service = new CardService({
      db: mockDb as never,
      eventBus: mockEventBus as never,
      logger: mockLogger as never,
    });
  });

  describe("updateStatus()", () => {
    it("updates DB and emits card:status-changed", async () => {
      const updateChain: Record<string, unknown> = {};
      updateChain.set = vi.fn().mockReturnValue(updateChain);
      updateChain.where = vi.fn().mockResolvedValue(undefined);
      mockDb.update = vi.fn().mockReturnValue(updateChain);

      await service.updateStatus(1, "running");

      expect(mockDb.update).toHaveBeenCalled();
      expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ status: "running" }));
      expect(mockEventBus.emit).toHaveBeenCalledWith("card:status-changed", {
        cardId: 1,
        status: "running",
      });
    });
  });

  describe("moveToColumn()", () => {
    it("fetches card, updates DB column, emits card:moved with fromColumn", async () => {
      // Setup select to return current card
      const selectChain: Record<string, unknown> = {};
      selectChain.from = vi.fn().mockReturnValue(selectChain);
      selectChain.where = vi.fn().mockResolvedValue([{ id: 1, column: "ready" }]);
      mockDb.select = vi.fn().mockReturnValue(selectChain);

      const updateChain: Record<string, unknown> = {};
      updateChain.set = vi.fn().mockReturnValue(updateChain);
      updateChain.where = vi.fn().mockResolvedValue(undefined);
      mockDb.update = vi.fn().mockReturnValue(updateChain);

      await service.moveToColumn(1, "in_progress");

      expect(mockDb.update).toHaveBeenCalled();
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ column: "in_progress" }),
      );
      expect(mockEventBus.emit).toHaveBeenCalledWith("card:moved", {
        cardId: 1,
        fromColumn: "ready",
        toColumn: "in_progress",
      });
    });

    it("throws if card not found", async () => {
      const selectChain: Record<string, unknown> = {};
      selectChain.from = vi.fn().mockReturnValue(selectChain);
      selectChain.where = vi.fn().mockResolvedValue([]);
      mockDb.select = vi.fn().mockReturnValue(selectChain);

      await expect(service.moveToColumn(999, "done")).rejects.toThrow("Card 999 not found");
    });
  });

  describe("markFailed()", () => {
    it("calls updateStatus(failed) and logEvent with reason", async () => {
      const updateChain: Record<string, unknown> = {};
      updateChain.set = vi.fn().mockReturnValue(updateChain);
      updateChain.where = vi.fn().mockResolvedValue(undefined);
      mockDb.update = vi.fn().mockReturnValue(updateChain);

      const insertChain: Record<string, unknown> = {};
      insertChain.values = vi.fn().mockReturnValue(insertChain);
      insertChain.returning = vi.fn().mockResolvedValue([{ id: 1 }]);
      mockDb.insert = vi.fn().mockReturnValue(insertChain);

      await service.markFailed(1, "tmux crashed");

      // Should have updated status to failed
      expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
      expect(mockEventBus.emit).toHaveBeenCalledWith("card:status-changed", {
        cardId: 1,
        status: "failed",
      });
      // Should have logged event
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it("calls updateStatus(failed) without logEvent when no reason", async () => {
      const updateChain: Record<string, unknown> = {};
      updateChain.set = vi.fn().mockReturnValue(updateChain);
      updateChain.where = vi.fn().mockResolvedValue(undefined);
      mockDb.update = vi.fn().mockReturnValue(updateChain);

      await service.markFailed(1);

      expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe("markComplete()", () => {
    it("calls updateStatus(review_ready) and moveToColumn(review)", async () => {
      // First call: updateStatus (update)
      // Second call: moveToColumn needs select + update
      let updateCallCount = 0;
      const updateChain1: Record<string, unknown> = {};
      updateChain1.set = vi.fn().mockReturnValue(updateChain1);
      updateChain1.where = vi.fn().mockResolvedValue(undefined);

      const updateChain2: Record<string, unknown> = {};
      updateChain2.set = vi.fn().mockReturnValue(updateChain2);
      updateChain2.where = vi.fn().mockResolvedValue(undefined);

      mockDb.update = vi.fn().mockImplementation(() => {
        updateCallCount++;
        return updateCallCount === 1 ? updateChain1 : updateChain2;
      });

      // moveToColumn needs to select card first
      const selectChain: Record<string, unknown> = {};
      selectChain.from = vi.fn().mockReturnValue(selectChain);
      selectChain.where = vi.fn().mockResolvedValue([{ id: 1, column: "in_progress" }]);
      mockDb.select = vi.fn().mockReturnValue(selectChain);

      await service.markComplete(1);

      // Should have emitted review_ready status
      expect(mockEventBus.emit).toHaveBeenCalledWith("card:status-changed", {
        cardId: 1,
        status: "review_ready",
      });
      // Should have emitted card:moved to review
      expect(mockEventBus.emit).toHaveBeenCalledWith("card:moved", {
        cardId: 1,
        fromColumn: "in_progress",
        toColumn: "review",
      });
    });
  });

  describe("logEvent()", () => {
    it("inserts into cardEvents table", async () => {
      const insertChain: Record<string, unknown> = {};
      insertChain.values = vi.fn().mockReturnValue(insertChain);
      insertChain.returning = vi.fn().mockResolvedValue([{ id: 1 }]);
      mockDb.insert = vi.fn().mockReturnValue(insertChain);

      await service.logEvent(1, "execution_start", "some detail");

      expect(mockDb.insert).toHaveBeenCalled();
      expect(insertChain.values).toHaveBeenCalledWith({
        cardId: 1,
        event: "execution_start",
        detail: "some detail",
      });
    });
  });

  describe("resolveDependencies()", () => {
    function setupResolveDb(
      depRows: Array<{ cardId: number }>,
      blockedCards: Array<Record<string, unknown>>,
      cardDeps: Array<{ dependsOnCardId: number }> = [],
      depCards: Array<Record<string, unknown>> = [],
    ) {
      const selectChains: Array<Record<string, unknown>> = [];

      // 1st: find cards depending on completedCardId
      const chain0: Record<string, unknown> = {};
      chain0.from = vi.fn().mockReturnValue(chain0);
      chain0.where = vi.fn().mockResolvedValue(depRows);
      selectChains.push(chain0);

      // 2nd: fetch blocked cards
      const chain1: Record<string, unknown> = {};
      chain1.from = vi.fn().mockReturnValue(chain1);
      chain1.where = vi.fn().mockResolvedValue(blockedCards);
      selectChains.push(chain1);

      // 3rd: getDeps for blocked card
      const chain2: Record<string, unknown> = {};
      chain2.from = vi.fn().mockReturnValue(chain2);
      chain2.where = vi.fn().mockResolvedValue(cardDeps);
      selectChains.push(chain2);

      // 4th: allDepsMet check
      const chain3: Record<string, unknown> = {};
      chain3.from = vi.fn().mockReturnValue(chain3);
      chain3.where = vi.fn().mockResolvedValue(depCards);
      selectChains.push(chain3);

      let callIdx = 0;
      mockDb.select = vi.fn().mockImplementation(() => selectChains[callIdx++]);

      const updateChain: Record<string, unknown> = {};
      updateChain.set = vi.fn().mockReturnValue(updateChain);
      updateChain.where = vi.fn().mockResolvedValue(undefined);
      mockDb.update = vi.fn().mockReturnValue(updateChain);

      return { updateChain };
    }

    it("returns empty when no cards depend on completed card", async () => {
      setupResolveDb([], []);

      const result = await service.resolveDependencies(1);
      expect(result).toEqual([]);
    });

    it("unblocks cards when all deps are done", async () => {
      setupResolveDb(
        [{ cardId: 10 }],
        [{ id: 10, status: "blocked" }],
        [{ dependsOnCardId: 1 }, { dependsOnCardId: 2 }],
        [
          { id: 1, status: "done" },
          { id: 2, status: "done" },
        ],
      );

      const result = await service.resolveDependencies(1);
      expect(result).toEqual([10]);
      expect(mockDb.update).toHaveBeenCalled();
    });

    it("does NOT unblock when some deps still pending", async () => {
      setupResolveDb(
        [{ cardId: 10 }],
        [{ id: 10, status: "blocked" }],
        [{ dependsOnCardId: 1 }, { dependsOnCardId: 2 }],
        [
          { id: 1, status: "done" },
          { id: 2, status: "running" },
        ],
      );

      const result = await service.resolveDependencies(1);
      expect(result).toEqual([]);
    });
  });
});
