import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies
vi.mock("../../server/db", () => {
  const mockChain = () => {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn().mockReturnValue(chain);
    chain.where = vi.fn().mockReturnValue(chain);
    chain.set = vi.fn().mockReturnValue(chain);
    chain.limit = vi.fn().mockResolvedValue([]);
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
  eventBus: { emit: vi.fn(), on: vi.fn() },
}));

vi.mock("../../server/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../server/services/tmux-manager", () => ({
  tmuxManager: {
    isAvailable: vi.fn().mockReturnValue(true),
    listSessions: vi.fn().mockReturnValue([]),
    sessionExists: vi.fn().mockReturnValue(true),
    startCapture: vi.fn(),
    killSession: vi.fn(),
  },
}));

// eslint-disable-next-line import/first -- vi.mock must come before imports (vitest hoisting)
import { db } from "../../server/db";
// eslint-disable-next-line import/first
import { eventBus } from "../../server/utils/event-bus";
// eslint-disable-next-line import/first
import { tmuxManager } from "../../server/services/tmux-manager";

const mockDb = vi.mocked(db);

// The plugin is async and runs its logic in defineNitroPlugin callback.
// We capture and invoke it manually.
async function runPlugin() {
  vi.stubGlobal("defineNitroPlugin", async (fn: () => Promise<void>) => fn());
  // Each import gets a cached module, so we need resetModules to re-run
  vi.resetModules();
  // Re-mock after resetModules
  vi.doMock("../../server/db", () => {
    return { db: mockDb };
  });
  vi.doMock("../../server/utils/event-bus", () => ({ eventBus }));
  vi.doMock("../../server/utils/logger", () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }));
  vi.doMock("../../server/services/tmux-manager", () => ({ tmuxManager }));

  await import("../../server/plugins/session-reconnect");
}

describe("Session Reconnect Plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips when tmux not available", async () => {
    vi.mocked(tmuxManager.isAvailable).mockReturnValue(false);

    await runPlugin();

    expect(tmuxManager.listSessions).not.toHaveBeenCalled();
  });

  it("no action when no orphaned sessions", async () => {
    vi.mocked(tmuxManager.isAvailable).mockReturnValue(true);
    vi.mocked(tmuxManager.listSessions).mockReturnValue([]);

    await runPlugin();

    expect(tmuxManager.killSession).not.toHaveBeenCalled();
  });

  it("kills session when card not found in DB", async () => {
    vi.mocked(tmuxManager.isAvailable).mockReturnValue(true);
    vi.mocked(tmuxManager.listSessions).mockReturnValue(["card-99"]);

    // inArray query returns no cards
    let selectCount = 0;
    mockDb.select = vi.fn().mockImplementation(() => {
      selectCount++;
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      if (selectCount === 1) {
        // Batch fetch cards by session IDs — returns empty
        chain.where = vi.fn().mockResolvedValue([]);
      } else {
        // Running cards query — returns empty
        chain.where = vi.fn().mockResolvedValue([]);
      }
      return chain;
    });

    await runPlugin();

    expect(tmuxManager.killSession).toHaveBeenCalledWith("card-99");
  });

  it("kills session when card is not running", async () => {
    vi.mocked(tmuxManager.isAvailable).mockReturnValue(true);
    vi.mocked(tmuxManager.listSessions).mockReturnValue(["card-5"]);

    let selectCount = 0;
    mockDb.select = vi.fn().mockImplementation(() => {
      selectCount++;
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      if (selectCount === 1) {
        // Batch fetch: card exists but is "done"
        chain.where = vi.fn().mockResolvedValue([{ id: 5, status: "done" }]);
      } else {
        // Running cards query
        chain.where = vi.fn().mockResolvedValue([]);
      }
      return chain;
    });

    await runPlugin();

    expect(tmuxManager.killSession).toHaveBeenCalledWith("card-5");
  });

  it("resumes capture for running card with live session", async () => {
    vi.mocked(tmuxManager.isAvailable).mockReturnValue(true);
    vi.mocked(tmuxManager.listSessions).mockReturnValue(["card-3"]);
    vi.mocked(tmuxManager.sessionExists).mockReturnValue(true);

    let selectCount = 0;
    mockDb.select = vi.fn().mockImplementation(() => {
      selectCount++;
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      if (selectCount === 1) {
        chain.where = vi.fn().mockResolvedValue([{ id: 3, status: "running" }]);
      } else {
        // Running cards without session — card-3 is in liveSessions so it's fine
        chain.where = vi.fn().mockResolvedValue([{ id: 3 }]);
      }
      return chain;
    });

    await runPlugin();

    expect(tmuxManager.startCapture).toHaveBeenCalledWith("card-3", expect.any(Function));
    expect(tmuxManager.killSession).not.toHaveBeenCalled();
  });

  it("marks card failed when session died between list and check", async () => {
    vi.mocked(tmuxManager.isAvailable).mockReturnValue(true);
    vi.mocked(tmuxManager.listSessions).mockReturnValue(["card-7"]);
    vi.mocked(tmuxManager.sessionExists).mockReturnValue(false);

    const updateChain: Record<string, unknown> = {};
    updateChain.set = vi.fn().mockReturnValue(updateChain);
    updateChain.where = vi.fn().mockResolvedValue(undefined);
    mockDb.update = vi.fn().mockReturnValue(updateChain);

    let selectCount = 0;
    mockDb.select = vi.fn().mockImplementation(() => {
      selectCount++;
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      if (selectCount === 1) {
        chain.where = vi.fn().mockResolvedValue([{ id: 7, status: "running" }]);
      } else {
        // Running cards — card-7 has no live session now
        chain.where = vi.fn().mockResolvedValue([{ id: 7 }]);
      }
      return chain;
    });

    await runPlugin();

    expect(mockDb.update).toHaveBeenCalled();
    expect(vi.mocked(eventBus.emit)).toHaveBeenCalledWith("card:status-changed", {
      cardId: 7,
      status: "failed",
    });
  });

  it("marks running card failed when it has no live tmux session", async () => {
    // Plugin requires live sessions to not bail early.
    // card-5 has a session and is done (gets killed), but card-20 is running
    // with no session — gets marked failed in the final sweep.
    vi.mocked(tmuxManager.isAvailable).mockReturnValue(true);
    vi.mocked(tmuxManager.listSessions).mockReturnValue(["card-5"]);

    const updateChain: Record<string, unknown> = {};
    updateChain.set = vi.fn().mockReturnValue(updateChain);
    updateChain.where = vi.fn().mockResolvedValue(undefined);
    mockDb.update = vi.fn().mockReturnValue(updateChain);

    let selectCount = 0;
    mockDb.select = vi.fn().mockImplementation(() => {
      selectCount++;
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      if (selectCount === 1) {
        // Batch fetch cards by session IDs — card 5 is done
        chain.where = vi.fn().mockResolvedValue([{ id: 5, status: "done" }]);
      } else {
        // Running cards query — card 20 is running but NOT in liveSessions
        chain.where = vi.fn().mockResolvedValue([{ id: 20, status: "running" }]);
      }
      return chain;
    });

    await runPlugin();

    expect(tmuxManager.killSession).toHaveBeenCalledWith("card-5");
    expect(mockDb.update).toHaveBeenCalled();
    expect(vi.mocked(eventBus.emit)).toHaveBeenCalledWith("card:status-changed", {
      cardId: 20,
      status: "failed",
    });
  });
});
