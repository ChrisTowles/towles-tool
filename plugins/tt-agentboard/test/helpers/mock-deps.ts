import { vi } from "vitest";

/** Create a mock Drizzle-like db with chainable select/update/insert */
export function createMockDb() {
  const mockChain = () => {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn().mockReturnValue(chain);
    chain.where = vi.fn().mockReturnValue(chain);
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

/** Create a mock TmuxManager */
export function createMockTmuxManager() {
  return {
    isAvailable: vi.fn().mockReturnValue(true),
    createSession: vi.fn().mockReturnValue({ sessionName: "card-1", created: true }),
    startCapture: vi.fn(),
    stopCapture: vi.fn(),
    killSession: vi.fn(),
    sendCommand: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
  };
}

export type MockTmuxManager = ReturnType<typeof createMockTmuxManager>;

/** Create a mock SlotAllocator */
export function createMockSlotAllocator() {
  return {
    claimSlot: vi.fn().mockResolvedValue({ id: 1, path: "/workspace/slot-1" }),
    releaseSlot: vi.fn().mockResolvedValue(undefined),
    getSlotForCard: vi.fn().mockResolvedValue(null),
  };
}

/** Create a mock WorkflowLoader */
export function createMockWorkflowLoader() {
  return {
    get: vi.fn().mockReturnValue(null),
  };
}

/** Create a mock ContextBundler */
export function createMockContextBundler() {
  return {
    buildPrompt: vi.fn().mockReturnValue("test prompt"),
  };
}

/** Create a mock CardService */
export function createMockCardService() {
  return {
    updateStatus: vi.fn().mockResolvedValue(undefined),
    moveToColumn: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    markComplete: vi.fn().mockResolvedValue(undefined),
    logEvent: vi.fn().mockResolvedValue(undefined),
    resolveDependencies: vi.fn().mockResolvedValue([]),
  };
}

export type MockCardService = ReturnType<typeof createMockCardService>;

/** Create a mock WorkflowRunner */
export function createMockWorkflowRunner() {
  return {
    run: vi.fn().mockResolvedValue(undefined),
  };
}

/** Create a mock WorkflowOrchestrator */
export function createMockWorkflowOrchestrator() {
  return {
    run: vi.fn().mockResolvedValue(undefined),
  };
}

/** Create a mock StepExecutor */
export function createMockStepExecutor() {
  return {
    execute: vi.fn().mockResolvedValue({ passed: true, artifact: "PASS\ndetails" }),
  };
}

/** Create a mock StreamTailer */
export function createMockStreamTailer() {
  return {
    startTailing: vi.fn().mockResolvedValue(undefined),
    stopTailing: vi.fn(),
  };
}

/** Create a mock execSync function */
export function createMockExecSync() {
  return vi.fn().mockReturnValue(Buffer.from(""));
}

/** Helper to configure mock db select to return specific rows */
export function setupSelectReturning(mockDb: MockDb, rows: unknown[]) {
  const selectChain: Record<string, unknown> = {};
  selectChain.from = vi.fn().mockReturnValue(selectChain);
  selectChain.where = vi.fn().mockResolvedValue(rows);
  mockDb.select = vi.fn().mockReturnValue(selectChain);
}

/** Helper to configure mock db update */
export function setupUpdate(mockDb: MockDb) {
  const updateChain: Record<string, unknown> = {};
  updateChain.set = vi.fn().mockReturnValue(updateChain);
  updateChain.where = vi.fn().mockResolvedValue(undefined);
  mockDb.update = vi.fn().mockReturnValue(updateChain);
  return updateChain;
}

/** Helper to configure mock db insert */
export function setupInsert(mockDb: MockDb) {
  const insertChain: Record<string, unknown> = {};
  insertChain.values = vi.fn().mockReturnValue(insertChain);
  insertChain.returning = vi.fn().mockResolvedValue([{ id: 1 }]);
  mockDb.insert = vi.fn().mockReturnValue(insertChain);
}
