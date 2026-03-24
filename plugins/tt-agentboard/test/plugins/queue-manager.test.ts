import { describe, it, expect, vi, beforeEach } from "vitest";

// We test the queue manager's event handler directly by capturing
// the callback passed to eventBus.on("slot:released", ...).

const mockEmit = vi.fn();
const mockOn = vi.fn();

vi.mock("../../server/db", () => {
  const mockChain = () => {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn().mockReturnValue(chain);
    chain.where = vi.fn().mockReturnValue(chain);
    chain.set = vi.fn().mockReturnValue(chain);
    chain.limit = vi.fn().mockResolvedValue([]);
    chain.orderBy = vi.fn().mockReturnValue(chain);
    return chain;
  };

  return {
    db: {
      select: vi.fn().mockReturnValue(mockChain()),
      update: vi.fn().mockReturnValue(mockChain()),
    },
  };
});

vi.mock("../../server/utils/event-bus", () => ({
  eventBus: { emit: mockEmit, on: mockOn },
}));

vi.mock("../../server/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../server/services/agent-executor", () => ({
  agentExecutor: {
    startExecution: vi.fn().mockResolvedValue(undefined),
  },
}));

// eslint-disable-next-line import/first -- vi.mock must come before imports (vitest hoisting)
import { db } from "../../server/db";
// eslint-disable-next-line import/first
import { agentExecutor } from "../../server/services/agent-executor";

const mockDb = vi.mocked(db);

describe("Queue Manager Plugin", () => {
  let slotReleasedHandler: (data: { slotId: number }) => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Stub defineNitroPlugin globally so the plugin module can call it
    vi.stubGlobal("defineNitroPlugin", (fn: () => void) => fn());

    // Reset module cache so the plugin re-registers
    vi.resetModules();

    // Re-apply mocks after resetModules (vi.mock is hoisted, but resetModules clears cache)
    // The vi.mock calls above are hoisted and still apply

    await import("../../server/plugins/queue-manager");

    // Extract the registered handler
    const slotReleasedCall = mockOn.mock.calls.find((c: unknown[]) => c[0] === "slot:released");
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
