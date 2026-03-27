import { describe, it, expect, vi, beforeEach } from "vitest";

import { createMockDb, createMockEventBus, createMockLogger } from "../helpers/mock-deps";
import { createQueueManager } from "../../server/plugins/queue-manager";

describe("Queue Manager Plugin", () => {
  let slotReleasedHandler: (data: { slotId: number }) => Promise<void>;
  let mockDb: ReturnType<typeof createMockDb>;
  let mockEventBus: ReturnType<typeof createMockEventBus>;
  let mockAgentExecutor: { startExecution: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    mockDb = createMockDb();
    mockEventBus = createMockEventBus();
    mockAgentExecutor = { startExecution: vi.fn().mockResolvedValue(undefined) };

    createQueueManager({
      db: mockDb as never,
      eventBus: mockEventBus as never,
      logger: createMockLogger() as never,
      agentExecutor: mockAgentExecutor,
      logCardEvent: vi.fn().mockResolvedValue(undefined),
    });

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
    expect(mockAgentExecutor.startExecution).toHaveBeenCalledWith(10);
  });

  it("skips when slot not found", async () => {
    const selectChain: Record<string, unknown> = {};
    selectChain.from = vi.fn().mockReturnValue(selectChain);
    selectChain.where = vi.fn().mockResolvedValue([]);
    mockDb.select = vi.fn().mockReturnValue(selectChain);

    await slotReleasedHandler({ slotId: 999 });

    expect(mockAgentExecutor.startExecution).not.toHaveBeenCalled();
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

    expect(mockAgentExecutor.startExecution).not.toHaveBeenCalled();
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

    expect(mockAgentExecutor.startExecution).not.toHaveBeenCalled();
  });
});
