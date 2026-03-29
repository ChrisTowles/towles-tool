import { describe, it, expect, vi } from "vitest";

import { pollRemoteSessions, checkRemoteSessionStatus } from "../../server/plugins/remote-poll";
import {
  createMockDb,
  createMockEventBus,
  createMockLogger,
  createMockCardService,
} from "../helpers/mock-deps";
import type { MockDb } from "../helpers/mock-deps";
import type { RemotePollDeps } from "../../server/plugins/remote-poll";

function setupRunningRemoteSessions(mockDb: MockDb, sessions: unknown[]) {
  const selectChain: Record<string, unknown> = {};
  selectChain.from = vi.fn().mockReturnValue(selectChain);
  selectChain.where = vi.fn().mockResolvedValue(sessions);
  mockDb.select = vi.fn().mockReturnValue(selectChain);
}

function setupUpdate(mockDb: MockDb) {
  const updateChain: Record<string, unknown> = {};
  updateChain.set = vi.fn().mockReturnValue(updateChain);
  updateChain.where = vi.fn().mockResolvedValue(undefined);
  mockDb.update = vi.fn().mockReturnValue(updateChain);
}

describe("remote-poll", () => {
  describe("checkRemoteSessionStatus", () => {
    it("returns completed for finished sessions", () => {
      const mockExecSync = vi
        .fn()
        .mockReturnValue(JSON.stringify([{ id: "session_abc", status: "completed" }]));
      expect(checkRemoteSessionStatus("session_abc", mockExecSync as never)).toBe("completed");
    });

    it("returns running for active sessions", () => {
      const mockExecSync = vi
        .fn()
        .mockReturnValue(JSON.stringify([{ id: "session_abc", status: "running" }]));
      expect(checkRemoteSessionStatus("session_abc", mockExecSync as never)).toBe("running");
    });

    it("returns failed for errored sessions", () => {
      const mockExecSync = vi
        .fn()
        .mockReturnValue(JSON.stringify([{ id: "session_abc", status: "failed" }]));
      expect(checkRemoteSessionStatus("session_abc", mockExecSync as never)).toBe("failed");
    });

    it("returns unknown when session not found", () => {
      const mockExecSync = vi.fn().mockReturnValue(JSON.stringify([]));
      expect(checkRemoteSessionStatus("session_abc", mockExecSync as never)).toBe("unknown");
    });

    it("returns unknown when execSync throws", () => {
      const mockExecSync = vi.fn().mockImplementation(() => {
        throw new Error("command failed");
      });
      expect(checkRemoteSessionStatus("session_abc", mockExecSync as never)).toBe("unknown");
    });
  });

  describe("pollRemoteSessions", () => {
    function createDeps(overrides: Partial<RemotePollDeps> = {}): RemotePollDeps & {
      mockDb: MockDb;
      mockCardService: ReturnType<typeof createMockCardService>;
    } {
      const mockDb = createMockDb();
      const mockCardService = createMockCardService();
      return {
        db: mockDb as never,
        logger: createMockLogger(),
        cardService: mockCardService as never,
        eventBus: createMockEventBus(),
        execSync: vi.fn() as never,
        pollIntervalMs: 1000,
        mockDb,
        mockCardService,
        ...overrides,
      };
    }

    it("does nothing when no running remote sessions", async () => {
      const deps = createDeps();
      setupRunningRemoteSessions(deps.mockDb, []);

      await pollRemoteSessions(deps);

      expect(deps.mockDb.update).not.toHaveBeenCalled();
    });

    it("marks completed sessions", async () => {
      const mockExecSync = vi
        .fn()
        .mockReturnValue(JSON.stringify([{ id: "session_abc", status: "completed" }]));
      const deps = createDeps({ execSync: mockExecSync as never });
      setupRunningRemoteSessions(deps.mockDb, [
        { id: 1, cardId: 42, remoteSessionId: "session_abc", status: "running" },
      ]);
      setupUpdate(deps.mockDb);

      await pollRemoteSessions(deps);

      expect(deps.mockCardService.markComplete).toHaveBeenCalledWith(42);
    });

    it("marks failed sessions", async () => {
      const mockExecSync = vi
        .fn()
        .mockReturnValue(JSON.stringify([{ id: "session_abc", status: "failed" }]));
      const deps = createDeps({ execSync: mockExecSync as never });
      setupRunningRemoteSessions(deps.mockDb, [
        { id: 1, cardId: 42, remoteSessionId: "session_abc", status: "running" },
      ]);
      setupUpdate(deps.mockDb);

      await pollRemoteSessions(deps);

      expect(deps.mockCardService.updateStatus).toHaveBeenCalledWith(42, "failed");
    });

    it("skips sessions still running", async () => {
      const mockExecSync = vi
        .fn()
        .mockReturnValue(JSON.stringify([{ id: "session_abc", status: "running" }]));
      const deps = createDeps({ execSync: mockExecSync as never });
      setupRunningRemoteSessions(deps.mockDb, [
        { id: 1, cardId: 42, remoteSessionId: "session_abc", status: "running" },
      ]);

      await pollRemoteSessions(deps);

      expect(deps.mockDb.update).not.toHaveBeenCalled();
    });
  });
});
