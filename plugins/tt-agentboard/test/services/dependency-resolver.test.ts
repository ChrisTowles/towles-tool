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

  describe("parseDeps()", () => {
    it("returns empty array for null", () => {
      expect(resolver.parseDeps(null)).toEqual([]);
    });

    it("returns empty array for empty string", () => {
      expect(resolver.parseDeps("")).toEqual([]);
    });

    it("parses comma-separated IDs", () => {
      expect(resolver.parseDeps("1,3,5")).toEqual([1, 3, 5]);
    });

    it("trims whitespace", () => {
      expect(resolver.parseDeps(" 1 , 3 , 5 ")).toEqual([1, 3, 5]);
    });

    it("filters out NaN and zero values", () => {
      expect(resolver.parseDeps("1,abc,0,-1,3")).toEqual([1, 3]);
    });

    it("returns empty array for malformed JSON-like string", () => {
      expect(resolver.parseDeps('{"ids":[1,2]}')).toEqual([]);
    });

    it("returns empty array for string with only separators", () => {
      expect(resolver.parseDeps(",,,")).toEqual([]);
    });
  });

  describe("resolveAfterCompletion()", () => {
    function setupMockDb(
      blockedCards: Array<Record<string, unknown>>,
      depCards: Array<Record<string, unknown>> = [],
    ) {
      // First select().from().where() call returns blocked cards
      const selectChain1: Record<string, unknown> = {};
      selectChain1.from = vi.fn().mockReturnValue(selectChain1);
      selectChain1.where = vi.fn().mockReturnValue(Promise.resolve(blockedCards));

      // Second select().from().where() call returns dep cards for allDepsMet check
      const selectChain2: Record<string, unknown> = {};
      selectChain2.from = vi.fn().mockReturnValue(selectChain2);
      selectChain2.where = vi.fn().mockReturnValue(Promise.resolve(depCards));

      const updateChain: Record<string, unknown> = {};
      updateChain.set = vi.fn().mockReturnValue(updateChain);
      updateChain.where = vi.fn().mockResolvedValue(undefined);

      let selectCallCount = 0;
      mockDb.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        return selectCallCount === 1 ? selectChain1 : selectChain2;
      });
      mockDb.update = vi.fn().mockReturnValue(updateChain);

      return { updateChain };
    }

    it("returns empty when no blocked cards exist", async () => {
      setupMockDb([]);

      const result = await resolver.resolveAfterCompletion(1);
      expect(result).toEqual([]);
    });

    it("returns empty when blocked card does not depend on completed card", async () => {
      setupMockDb([{ id: 10, dependsOn: "5,6", status: "blocked" }]);

      const result = await resolver.resolveAfterCompletion(1);
      expect(result).toEqual([]);
    });

    it("unblocks card when all deps are done", async () => {
      setupMockDb(
        [{ id: 10, dependsOn: "1,2", status: "blocked" }],
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
        [{ id: 10, dependsOn: "1,2", status: "blocked" }],
        [
          { id: 1, status: "done" },
          { id: 2, status: "running" },
        ],
      );

      const result = await resolver.resolveAfterCompletion(1);
      expect(result).toEqual([]);
    });

    it("skips blocked card with null dependsOn", async () => {
      setupMockDb([{ id: 15, dependsOn: null, status: "blocked" }]);

      const result = await resolver.resolveAfterCompletion(1);
      expect(result).toEqual([]);
    });

    it("skips blocked card with empty dependsOn string", async () => {
      setupMockDb([{ id: 16, dependsOn: "", status: "blocked" }]);

      const result = await resolver.resolveAfterCompletion(1);
      expect(result).toEqual([]);
    });

    it("unblocks multiple cards at once", async () => {
      // Two blocked cards both depend on card 1
      const blockedCards = [
        { id: 10, dependsOn: "1", status: "blocked" },
        { id: 11, dependsOn: "1", status: "blocked" },
      ];

      const selectChains: Array<Record<string, unknown>> = [];

      // First call: blocked cards query
      const chain0: Record<string, unknown> = {};
      chain0.from = vi.fn().mockReturnValue(chain0);
      chain0.where = vi.fn().mockResolvedValue(blockedCards);
      selectChains.push(chain0);

      // Second call: allDepsMet for card 10 (deps: [1])
      const chain1: Record<string, unknown> = {};
      chain1.from = vi.fn().mockReturnValue(chain1);
      chain1.where = vi.fn().mockResolvedValue([{ id: 1, status: "done" }]);
      selectChains.push(chain1);

      // Third call: allDepsMet for card 11 (deps: [1])
      const chain2: Record<string, unknown> = {};
      chain2.from = vi.fn().mockReturnValue(chain2);
      chain2.where = vi.fn().mockResolvedValue([{ id: 1, status: "done" }]);
      selectChains.push(chain2);

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
