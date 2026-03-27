import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createMockDb, createMockEventBus, createMockLogger } from "../helpers/mock-deps";

// We test the queue manager's event handler directly by capturing
// the callback passed to eventBus.on("slot:released", ...).

const mockEventBus = createMockEventBus();
const mockDb = createMockDb();

// eslint-disable-next-line jest/no-restricted-jest-methods -- Nitro plugin has no constructor for DI; SQLite can't load in test
vi.mock("../../server/db", () => ({ db: mockDb }));

// eslint-disable-next-line jest/no-restricted-jest-methods -- Nitro plugin has no constructor for DI
vi.mock("../../server/utils/event-bus", () => ({ eventBus: mockEventBus }));

// eslint-disable-next-line jest/no-restricted-jest-methods -- Nitro plugin has no constructor for DI
vi.mock("../../server/utils/logger", () => ({ logger: createMockLogger() }));

// eslint-disable-next-line jest/no-restricted-jest-methods -- Nitro plugin has no constructor for DI
vi.mock("../../server/services/agent-executor", () => ({
  agentExecutor: {
    startExecution: vi.fn().mockResolvedValue(undefined),
  },
}));

// eslint-disable-next-line import/first -- vi.mock must come before imports (vitest hoisting)
import { agentExecutor } from "../../server/services/agent-executor";

describe("Queue Manager Plugin", () => {
  let slotReleasedHandler: (data: { slotId: number }) => Promise<void>;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // Stub defineNitroPlugin globally so the plugin module can call it
    // eslint-disable-next-line jest/no-restricted-jest-methods -- Nitro plugin requires global defineNitroPlugin
    vi.stubGlobal("defineNitroPlugin", (fn: () => void) => fn());

    // Reset module cache so the plugin re-registers
    vi.resetModules();

    // Re-apply mocks after resetModules (vi.mock is hoisted, but resetModules clears cache)
    // The vi.mock calls above are hoisted and still apply

    await import("../../server/plugins/queue-manager");

    // Extract the registered handler
    const slotReleasedCall = mockEventBus.on.mock.calls.find(
      (c: unknown[]) => c[0] === "slot:released",
    );
    expect(slotReleasedCall).toBeTruthy();
    slotReleasedHandler = slotReleasedCall![1] as (data: { slotId: number }) => Promise<void>;
  });

  it("starts next queued card when slot released", async () => {
    const slot = { id: 1, repoId: 1 };
    const queuedCard = { id: 10, column: "in_progress", status: "queued", repoId: 1 };

    let selectCount = 0;
    mockDb.select = vi.fn().mockImplementation(() => {
      selectCount++;
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      chain.where = vi.fn().mockReturnValue(chain);
      chain.orderBy = vi.fn().mockReturnValue(chain);

      if (selectCount === 1) {
        // Slot query
        chain.where = vi.fn().mockResolvedValue([slot]);
      } else if (selectCount === 2) {
        // Running cards count
        chain.where = vi.fn().mockResolvedValue([]); // 0 running
      } else {
        // Queued cards for repo
        chain.where = vi.fn().mockReturnValue(chain);
        chain.orderBy = vi.fn().mockReturnValue(chain);
        chain.limit = vi.fn().mockResolvedValue([queuedCard]);
      }
      return chain;
    });

    const updateChain: Record<string, unknown> = {};
    updateChain.set = vi.fn().mockReturnValue(updateChain);
    updateChain.where = vi.fn().mockResolvedValue(undefined);
    mockDb.update = vi.fn().mockReturnValue(updateChain);

    await slotReleasedHandler({ slotId: 1 });

    expect(mockDb.update).toHaveBeenCalled();
    expect(vi.mocked(agentExecutor.startExecution)).toHaveBeenCalledWith(10);
  });

  it("skips when slot not found", async () => {
    const selectChain: Record<string, unknown> = {};
    selectChain.from = vi.fn().mockReturnValue(selectChain);
    selectChain.where = vi.fn().mockResolvedValue([]);
    mockDb.select = vi.fn().mockReturnValue(selectChain);

    await slotReleasedHandler({ slotId: 999 });

    expect(vi.mocked(agentExecutor.startExecution)).not.toHaveBeenCalled();
  });

  it("skips when MAX_CONCURRENT reached", async () => {
    const slot = { id: 1, repoId: 1 };
    const runningCards = [{ id: 1 }, { id: 2 }, { id: 3 }]; // 3 = default MAX_CONCURRENT

    let selectCount = 0;
    mockDb.select = vi.fn().mockImplementation(() => {
      selectCount++;
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      if (selectCount === 1) {
        chain.where = vi.fn().mockResolvedValue([slot]);
      } else {
        chain.where = vi.fn().mockResolvedValue(runningCards);
      }
      return chain;
    });

    await slotReleasedHandler({ slotId: 1 });

    expect(vi.mocked(agentExecutor.startExecution)).not.toHaveBeenCalled();
  });

  it("does nothing when no queued cards for repo", async () => {
    const slot = { id: 1, repoId: 1 };

    let selectCount = 0;
    mockDb.select = vi.fn().mockImplementation(() => {
      selectCount++;
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      chain.where = vi.fn().mockReturnValue(chain);
      chain.orderBy = vi.fn().mockReturnValue(chain);

      if (selectCount === 1) {
        chain.where = vi.fn().mockResolvedValue([slot]);
      } else if (selectCount === 2) {
        chain.where = vi.fn().mockResolvedValue([]); // 0 running
      } else {
        chain.limit = vi.fn().mockResolvedValue([]); // no queued
      }
      return chain;
    });

    await slotReleasedHandler({ slotId: 1 });

    expect(vi.mocked(agentExecutor.startExecution)).not.toHaveBeenCalled();
  });
});
