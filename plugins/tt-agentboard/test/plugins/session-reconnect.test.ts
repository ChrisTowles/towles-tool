import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  createMockDb,
  createMockEventBus,
  createMockLogger,
  createMockCardService,
} from "../helpers/mock-deps";
import { createSessionReconnect } from "../../server/plugins/session-reconnect";

describe("Session Reconnect Plugin", () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let mockEventBus: ReturnType<typeof createMockEventBus>;
  let mockCardService: ReturnType<typeof createMockCardService>;
  let mockTmuxManager: {
    isAvailable: ReturnType<typeof vi.fn>;
    listSessions: ReturnType<typeof vi.fn>;
    sessionExists: ReturnType<typeof vi.fn>;
    startCapture: ReturnType<typeof vi.fn>;
    killSession: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    mockEventBus = createMockEventBus();
    mockCardService = createMockCardService();
    mockTmuxManager = {
      isAvailable: vi.fn().mockReturnValue(true),
      listSessions: vi.fn().mockReturnValue([]),
      sessionExists: vi.fn().mockReturnValue(true),
      startCapture: vi.fn(),
      killSession: vi.fn(),
    };
  });

  function runPlugin() {
    return createSessionReconnect({
      db: mockDb as never,
      tmuxManager: mockTmuxManager,
      eventBus: mockEventBus as never,
      logger: createMockLogger() as never,
      cardService: mockCardService as never,
    });
  }

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

    let selectCount = 0;
    mockDb.select = vi.fn().mockImplementation(() => {
      selectCount++;
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      if (selectCount === 1) {
        chain.where = vi.fn().mockResolvedValue([]);
      } else {
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
        chain.where = vi.fn().mockResolvedValue([{ id: 5, status: "done" }]);
      } else {
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
        chain.where = vi.fn().mockResolvedValue([{ id: 7 }]);
      }
      return chain;
    });

    await runPlugin();

    expect(mockCardService.markFailed).toHaveBeenCalledWith(
      7,
      "session card-7 died between list and check",
    );
  });

  it("marks running card failed when it has no live tmux session", async () => {
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
        chain.where = vi.fn().mockResolvedValue([{ id: 5, status: "done" }]);
      } else {
        chain.where = vi.fn().mockResolvedValue([{ id: 20, status: "running" }]);
      }
      return chain;
    });

    await runPlugin();

    expect(mockTmuxManager.killSession).toHaveBeenCalledWith("card-5");
    expect(mockCardService.markFailed).toHaveBeenCalledWith(20, "session not found on restart");
  });
});
