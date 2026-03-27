import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockDb, createMockLogger } from "../helpers/mock-deps";
import { DependencyResolver } from "../../server/services/dependency-resolver";

describe("DependencyResolver", () => {
  let resolver: DependencyResolver;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    resolver = new DependencyResolver({
      db: mockDb as never,
      logger: createMockLogger() as never,
    });
    vi.clearAllMocks();
  });

  describe("getDeps()", () => {
    it("returns empty array when no dependencies exist", async () => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      chain.where = vi.fn().mockResolvedValue([]);
      mockDb.select = vi.fn().mockReturnValue(chain);

      const result = await resolver.getDeps(1);
      expect(result).toEqual([]);
    });

    it("returns dependency card IDs", async () => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      chain.where = vi.fn().mockResolvedValue([{ dependsOnCardId: 3 }, { dependsOnCardId: 5 }]);
      mockDb.select = vi.fn().mockReturnValue(chain);

      const result = await resolver.getDeps(1);
      expect(result).toEqual([3, 5]);
    });
  });

  describe("resolveAfterCompletion()", () => {
    function setupMockDb(
      depRows: Array<{ cardId: number }>,
      blockedCards: Array<Record<string, unknown>>,
      cardDeps: Array<{ dependsOnCardId: number }> = [],
      depCards: Array<Record<string, unknown>> = [],
    ) {
      const selectChains: Array<Record<string, unknown>> = [];

      // 1st call: find cards that depend on completedCardId (from cardDependencies)
      const chain0: Record<string, unknown> = {};
      chain0.from = vi.fn().mockReturnValue(chain0);
      chain0.where = vi.fn().mockResolvedValue(depRows);
      selectChains.push(chain0);

      // 2nd call: fetch blocked cards by IDs
      const chain1: Record<string, unknown> = {};
      chain1.from = vi.fn().mockReturnValue(chain1);
      chain1.where = vi.fn().mockResolvedValue(blockedCards);
      selectChains.push(chain1);

      // 3rd call: getDeps for the blocked card (cardDependencies)
      const chain2: Record<string, unknown> = {};
      chain2.from = vi.fn().mockReturnValue(chain2);
      chain2.where = vi.fn().mockResolvedValue(cardDeps);
      selectChains.push(chain2);

      // 4th call: allDepsMet check (cards table)
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
      setupMockDb([], []);

      const result = await resolver.resolveAfterCompletion(1);
      expect(result).toEqual([]);
    });

    it("returns empty when dependent card is not blocked", async () => {
      setupMockDb([{ cardId: 10 }], [{ id: 10, status: "running" }]);

      const result = await resolver.resolveAfterCompletion(1);
      expect(result).toEqual([]);
    });

    it("unblocks card when all deps are done", async () => {
      setupMockDb(
        [{ cardId: 10 }],
        [{ id: 10, status: "blocked" }],
        [{ dependsOnCardId: 1 }, { dependsOnCardId: 2 }],
        [
          { id: 1, status: "done" },
          { id: 2, status: "done" },
        ],
      );

      const result = await resolver.resolveAfterCompletion(1);
      expect(result).toEqual([10]);
    });

    it("does not unblock card when some deps still not done", async () => {
      setupMockDb(
        [{ cardId: 10 }],
        [{ id: 10, status: "blocked" }],
        [{ dependsOnCardId: 1 }, { dependsOnCardId: 2 }],
        [
          { id: 1, status: "done" },
          { id: 2, status: "running" },
        ],
      );

      const result = await resolver.resolveAfterCompletion(1);
      expect(result).toEqual([]);
    });

    it("unblocks multiple cards at once", async () => {
      const selectChains: Array<Record<string, unknown>> = [];

      // 1st call: find cards that depend on completedCardId
      const chain0: Record<string, unknown> = {};
      chain0.from = vi.fn().mockReturnValue(chain0);
      chain0.where = vi.fn().mockResolvedValue([{ cardId: 10 }, { cardId: 11 }]);
      selectChains.push(chain0);

      // 2nd call: fetch blocked cards
      const chain1: Record<string, unknown> = {};
      chain1.from = vi.fn().mockReturnValue(chain1);
      chain1.where = vi.fn().mockResolvedValue([
        { id: 10, status: "blocked" },
        { id: 11, status: "blocked" },
      ]);
      selectChains.push(chain1);

      // 3rd: getDeps for card 10
      const chain2: Record<string, unknown> = {};
      chain2.from = vi.fn().mockReturnValue(chain2);
      chain2.where = vi.fn().mockResolvedValue([{ dependsOnCardId: 1 }]);
      selectChains.push(chain2);

      // 4th: allDepsMet for card 10
      const chain3: Record<string, unknown> = {};
      chain3.from = vi.fn().mockReturnValue(chain3);
      chain3.where = vi.fn().mockResolvedValue([{ id: 1, status: "done" }]);
      selectChains.push(chain3);

      // 5th: getDeps for card 11
      const chain4: Record<string, unknown> = {};
      chain4.from = vi.fn().mockReturnValue(chain4);
      chain4.where = vi.fn().mockResolvedValue([{ dependsOnCardId: 1 }]);
      selectChains.push(chain4);

      // 6th: allDepsMet for card 11
      const chain5: Record<string, unknown> = {};
      chain5.from = vi.fn().mockReturnValue(chain5);
      chain5.where = vi.fn().mockResolvedValue([{ id: 1, status: "done" }]);
      selectChains.push(chain5);

      let callIdx = 0;
      mockDb.select = vi.fn().mockImplementation(() => selectChains[callIdx++]);

      const updateChain: Record<string, unknown> = {};
      updateChain.set = vi.fn().mockReturnValue(updateChain);
      updateChain.where = vi.fn().mockResolvedValue(undefined);
      mockDb.update = vi.fn().mockReturnValue(updateChain);

      const result = await resolver.resolveAfterCompletion(1);
      expect(result).toEqual([10, 11]);
      expect(mockDb.update).toHaveBeenCalledTimes(2);
    });
  });
});
