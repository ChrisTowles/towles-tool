import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { execSync } from "node:child_process";

import { createMockDb, createMockEventBus, createMockLogger } from "../helpers/mock-deps";

// Track sessions we create so we can clean up
const createdSessions: string[] = [];

function isTmuxAvailable(): boolean {
  try {
    execSync("which tmux", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function createTmuxSession(name: string): void {
  execSync(`tmux new-session -d -s ${name}`, { stdio: "ignore" });
  createdSessions.push(name);
}

function killTmuxSession(name: string): void {
  try {
    execSync(`tmux kill-session -t ${name}`, { stdio: "ignore" });
  } catch {
    // session may already be dead
  }
}

function tmuxSessionExists(name: string): boolean {
  try {
    execSync(`tmux has-session -t ${name}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function listCardSessions(): string[] {
  try {
    const output = execSync('tmux list-sessions -F "#{session_name}"', {
      encoding: "utf-8",
    });
    return output
      .trim()
      .split("\n")
      .filter((s) => s.startsWith("card-"));
  } catch {
    return [];
  }
}

afterAll(() => {
  for (const name of createdSessions) {
    killTmuxSession(name);
  }
});

describe("Session Reconnect Live (real tmux)", { timeout: 30_000 }, () => {
  const tmuxAvailable = isTmuxAvailable();

  describe("real tmux session lifecycle", () => {
    it("creates and detects a live tmux session", ({ skip }) => {
      if (!tmuxAvailable) skip();

      const sessionName = "card-9001";
      createTmuxSession(sessionName);

      expect(tmuxSessionExists(sessionName)).toBe(true);

      const sessions = listCardSessions();
      expect(sessions).toContain(sessionName);

      killTmuxSession(sessionName);
      expect(tmuxSessionExists(sessionName)).toBe(false);
    });

    it("session disappears from list after kill", ({ skip }) => {
      if (!tmuxAvailable) skip();

      const sessionName = "card-9002";
      createTmuxSession(sessionName);
      expect(tmuxSessionExists(sessionName)).toBe(true);

      killTmuxSession(sessionName);

      const sessions = listCardSessions();
      expect(sessions).not.toContain(sessionName);
    });
  });

  describe("orphan detection scenarios", () => {
    it("detects session with no matching card as orphan candidate", ({ skip }) => {
      if (!tmuxAvailable) skip();

      const sessionName = "card-8888";
      createTmuxSession(sessionName);

      const sessions = listCardSessions();
      expect(sessions).toContain(sessionName);

      // In reconnect logic, if card 8888 doesn't exist in DB, this session is orphaned.
      // We verify the session name parsing extracts the correct card ID.
      const match = sessionName.match(/^card-(\d+)$/);
      expect(match).not.toBeNull();
      expect(Number(match![1])).toBe(8888);

      killTmuxSession(sessionName);
    });

    it("handles multiple orphaned sessions", ({ skip }) => {
      if (!tmuxAvailable) skip();

      const sessions = ["card-7001", "card-7002", "card-7003"];
      for (const s of sessions) {
        createTmuxSession(s);
      }

      const liveSessions = listCardSessions();
      for (const s of sessions) {
        expect(liveSessions).toContain(s);
      }

      // Clean up
      for (const s of sessions) {
        killTmuxSession(s);
      }

      // Verify all gone
      const afterSessions = listCardSessions();
      for (const s of sessions) {
        expect(afterSessions).not.toContain(s);
      }
    });
  });

  describe("race condition: session dies between list and check", () => {
    it("session listed but dies before has-session check", ({ skip }) => {
      if (!tmuxAvailable) skip();

      const sessionName = "card-6001";
      createTmuxSession(sessionName);

      // Simulate: list shows it
      const sessions = listCardSessions();
      expect(sessions).toContain(sessionName);

      // Kill it (simulates it dying between list and check)
      killTmuxSession(sessionName);

      // Now has-session should return false
      expect(tmuxSessionExists(sessionName)).toBe(false);

      // This is the edge case the reconnect plugin handles:
      // it finds the session in list, but by the time it calls sessionExists(),
      // the session is gone. The plugin should mark the card as failed.
    });
  });
});

// Mock dependencies for plugin tests
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

async function runPlugin() {
  // eslint-disable-next-line jest/no-restricted-jest-methods -- Nitro plugin requires global defineNitroPlugin
  vi.stubGlobal("defineNitroPlugin", async (fn: () => Promise<void>) => fn());
  vi.resetModules();
  vi.doMock("../../server/db", () => ({ db: mockDb }));
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

describe("Session Reconnect Plugin (mocked)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resumes capture for running card and marks orphaned card failed", async () => {
    // Scenario: card-3 is running with a live session, card-50 is running with no session
    mockTmuxManager.isAvailable.mockReturnValue(true);
    mockTmuxManager.listSessions.mockReturnValue(["card-3"]);
    mockTmuxManager.sessionExists.mockReturnValue(true);

    let selectCount = 0;
    mockDb.select = vi.fn().mockImplementation(() => {
      selectCount++;
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      if (selectCount === 1) {
        // Batch fetch cards by session IDs
        chain.where = vi.fn().mockResolvedValue([{ id: 3, status: "running" }]);
      } else {
        // Running cards query — card 3 AND card 50 are running
        chain.where = vi.fn().mockResolvedValue([
          { id: 3, status: "running" },
          { id: 50, status: "running" },
        ]);
      }
      return chain;
    });

    const updateChain: Record<string, unknown> = {};
    updateChain.set = vi.fn().mockReturnValue(updateChain);
    updateChain.where = vi.fn().mockResolvedValue(undefined);
    mockDb.update = vi.fn().mockReturnValue(updateChain);

    await runPlugin();

    // card-3 should get capture resumed (it has a live session)
    expect(mockTmuxManager.startCapture).toHaveBeenCalledWith("card-3", expect.any(Function));

    // card-50 should be marked failed (running but no session)
    expect(mockEventBus.emit).toHaveBeenCalledWith("card:status-changed", {
      cardId: 50,
      status: "failed",
    });
  });

  it("handles session that dies between list and existence check", async () => {
    mockTmuxManager.isAvailable.mockReturnValue(true);
    mockTmuxManager.listSessions.mockReturnValue(["card-15"]);
    // Session dies between list and has-session check
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
        chain.where = vi.fn().mockResolvedValue([{ id: 15, status: "running" }]);
      } else {
        chain.where = vi.fn().mockResolvedValue([{ id: 15 }]);
      }
      return chain;
    });

    await runPlugin();

    // Card should be marked failed since session died
    expect(mockDb.update).toHaveBeenCalled();
    expect(mockEventBus.emit).toHaveBeenCalledWith("card:status-changed", {
      cardId: 15,
      status: "failed",
    });
  });
});
