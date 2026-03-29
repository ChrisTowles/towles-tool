import { vi } from "vitest";

/**
 * Mock helpers for system-boundary dependencies (tmux, execSync, spawn, etc.)
 *
 * For DB-backed tests, use test-db.ts helpers instead.
 * These remain for tests that interact with system processes and need
 * to verify which commands were called.
 */

// ---------------------------------------------------------------------------
// Still used by: integration/session-reconnect-live.test.ts
// Keep until that integration test is migrated to real DB helpers
// ---------------------------------------------------------------------------

/** Create a mock Drizzle-like db with chainable select/update/insert */
export function createMockDb() {
  const mockChain = () => {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn().mockReturnValue(chain);
    chain.where = vi.fn().mockReturnValue(chain);
    chain.orderBy = vi.fn().mockReturnValue(chain);
    chain.set = vi.fn().mockReturnValue(chain);
    chain.limit = vi.fn().mockResolvedValue([]);
    chain.values = vi.fn().mockReturnValue(chain);
    chain.returning = vi.fn().mockResolvedValue([{ id: 1 }]);
    return chain;
  };

  return {
    select: vi.fn().mockReturnValue(mockChain()),
    update: vi.fn().mockReturnValue(mockChain()),
    insert: vi.fn().mockReturnValue(mockChain()),
  };
}

export type MockDb = ReturnType<typeof createMockDb>;

/** Create a mock logger matching consola's interface */
export function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

export type MockLogger = ReturnType<typeof createMockLogger>;

/** Create a mock EventEmitter-based event bus */
export function createMockEventBus() {
  return {
    emit: vi.fn(),
    on: vi.fn(),
  };
}

export type MockEventBus = ReturnType<typeof createMockEventBus>;

// ---------------------------------------------------------------------------
// System-boundary mocks (used by tmux-manager, github-service, etc.)
// ---------------------------------------------------------------------------

/** Create a mock execSync function */
export function createMockExecSync() {
  return vi.fn().mockReturnValue(Buffer.from(""));
}

/** Create a mock CardService — used by integration tests */
export function createMockCardService() {
  return {
    updateStatus: vi.fn().mockResolvedValue(undefined),
    moveToColumn: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    markComplete: vi.fn().mockResolvedValue(undefined),
    logEvent: vi.fn().mockResolvedValue(undefined),
    resolveDependencies: vi.fn().mockResolvedValue([]),
    getDepsMap: vi.fn().mockResolvedValue(new Map()),
  };
}

export type MockCardService = ReturnType<typeof createMockCardService>;
