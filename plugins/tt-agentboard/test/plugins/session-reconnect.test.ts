import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createMockDb, createMockEventBus, createMockLogger } from "../helpers/mock-deps";

const mockDb = createMockDb();
const mockEventBus = createMockEventBus();
const mockTmuxManager = {
  isAvailable: vi.fn().mockReturnValue(true),
  listSessions: vi.fn().mockReturnValue([]),
  sessionExists: vi.fn().mockReturnValue(true),
  startCapture: vi.fn(),
  killSession: vi.fn(),
};

// eslint-disable-next-line jest/no-restricted-jest-methods -- Nitro plugin has no constructor for DI; SQLite can't load in test
vi.mock("../../server/db", () => ({ db: mockDb }));

// eslint-disable-next-line jest/no-restricted-jest-methods -- Nitro plugin has no constructor for DI
vi.mock("../../server/utils/card-events", () => ({
  logCardEvent: vi.fn().mockResolvedValue(undefined),
}));

// eslint-disable-next-line jest/no-restricted-jest-methods -- Nitro plugin has no constructor for DI
vi.mock("../../server/utils/event-bus", () => ({ eventBus: mockEventBus }));

// eslint-disable-next-line jest/no-restricted-jest-methods -- Nitro plugin has no constructor for DI
vi.mock("../../server/utils/logger", () => ({ logger: createMockLogger() }));

// eslint-disable-next-line jest/no-restricted-jest-methods -- Nitro plugin has no constructor for DI
vi.mock("../../server/services/tmux-manager", () => ({ tmuxManager: mockTmuxManager }));

// The plugin is async and runs its logic in defineNitroPlugin callback.
// We capture and invoke it manually.
async function runPlugin() {
  // eslint-disable-next-line jest/no-restricted-jest-methods -- Nitro plugin requires global defineNitroPlugin
  vi.stubGlobal("defineNitroPlugin", async (fn: () => Promise<void>) => fn());
  // Each import gets a cached module, so we need resetModules to re-run
  vi.resetModules();
  // Re-mock after resetModules
  vi.doMock("../../server/db", () => {
    return { db: mockDb };
  });
  vi.doMock("../../server/utils/event-bus", () => ({ eventBus: mockEventBus }));
  vi.doMock("../../server/utils/logger", () => ({
    logger: createMockLogger(),
  }));
  vi.doMock("../../server/services/tmux-manager", () => ({ tmuxManager: mockTmuxManager }));
  vi.doMock("../../server/utils/card-events", () => ({
    logCardEvent: vi.fn().mockResolvedValue(undefined),
  }));

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
    mockTmuxManager.isAvailable.mockReturnValue(false);

    await runPlugin();

    expect(mockTmuxManager.listSessions).not.toHaveBeenCalled();
  });

  it("no action when no orphaned sessions", async () => {
    mockTmuxManager.isAvailable.mockReturnValue(true);
    mockTmuxManager.listSessions.mockReturnValue([]);

    await runPlugin();

    expect(mockTmuxManager.killSession).not.toHaveBeenCalled();
  });

  it("kills session when card not found in DB", async () => {
    mockTmuxManager.isAvailable.mockReturnValue(true);
    mockTmuxManager.listSessions.mockReturnValue(["card-99"]);

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

    expect(mockTmuxManager.killSession).toHaveBeenCalledWith("card-99");
  });

  it("kills session when card is not running", async () => {
    mockTmuxManager.isAvailable.mockReturnValue(true);
    mockTmuxManager.listSessions.mockReturnValue(["card-5"]);

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

    expect(mockTmuxManager.killSession).toHaveBeenCalledWith("card-5");
  });

  it("resumes capture for running card with live session", async () => {
    mockTmuxManager.isAvailable.mockReturnValue(true);
    mockTmuxManager.listSessions.mockReturnValue(["card-3"]);
    mockTmuxManager.sessionExists.mockReturnValue(true);

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

    expect(mockTmuxManager.startCapture).toHaveBeenCalledWith("card-3", expect.any(Function));
    expect(mockTmuxManager.killSession).not.toHaveBeenCalled();
  });

  it("marks card failed when session died between list and check", async () => {
    mockTmuxManager.isAvailable.mockReturnValue(true);
    mockTmuxManager.listSessions.mockReturnValue(["card-7"]);
    mockTmuxManager.sessionExists.mockReturnValue(false);

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
    expect(mockEventBus.emit).toHaveBeenCalledWith("card:status-changed", {
      cardId: 7,
      status: "failed",
    });
  });

  it("marks running card failed when it has no live tmux session", async () => {
    // Plugin requires live sessions to not bail early.
    // card-5 has a session and is done (gets killed), but card-20 is running
    // with no session — gets marked failed in the final sweep.
    mockTmuxManager.isAvailable.mockReturnValue(true);
    mockTmuxManager.listSessions.mockReturnValue(["card-5"]);

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

    expect(mockTmuxManager.killSession).toHaveBeenCalledWith("card-5");
    expect(mockDb.update).toHaveBeenCalled();
    expect(mockEventBus.emit).toHaveBeenCalledWith("card:status-changed", {
      cardId: 20,
      status: "failed",
    });
  });
});
