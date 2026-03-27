import { vi } from "vitest";

export function createMockDb() {
  const mockChain = () => {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn().mockReturnValue(chain);
    chain.where = vi.fn().mockReturnValue(chain);
    chain.set = vi.fn().mockReturnValue(chain);
    chain.values = vi.fn().mockResolvedValue(undefined);
    chain.limit = vi.fn().mockResolvedValue([]);
    chain.returning = vi.fn().mockResolvedValue([]);
    chain.orderBy = vi.fn().mockReturnValue(chain);
    return chain;
  };
  return {
    select: vi.fn().mockReturnValue(mockChain()),
    update: vi.fn().mockReturnValue(mockChain()),
    insert: vi.fn().mockReturnValue(mockChain()),
    delete: vi.fn().mockReturnValue(mockChain()),
  };
}

export function createMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

export function createMockEventBus() {
  return { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
}

export function createMockTmuxManager() {
  return {
    isAvailable: vi.fn().mockReturnValue(true),
    createSession: vi.fn().mockReturnValue({ sessionName: "card-1", created: true }),
    startCapture: vi.fn(),
    stopCapture: vi.fn(),
    killSession: vi.fn().mockReturnValue(true),
    sendCommand: vi.fn(),
    sessionExists: vi.fn().mockReturnValue(false),
    listAgentSessions: vi.fn().mockReturnValue([]),
  };
}
