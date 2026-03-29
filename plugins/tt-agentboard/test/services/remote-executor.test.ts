import { describe, it, expect, vi } from "vitest";

import { RemoteExecutor } from "../../server/domains/execution/remote-executor";
import {
  createMockDb,
  createMockEventBus,
  createMockLogger,
  createMockCardService,
  setupSelectReturning,
  setupInsert,
} from "../helpers/mock-deps";

const CLAUDE_REMOTE_OUTPUT = `Created remote session: Test implementation and validation
View: https://claude.ai/code/session_01CLmof84P5YY3MboTRacDLg?m=0
Resume with: claude --teleport session_01CLmof84P5YY3MboTRacDLg
`;

describe("RemoteExecutor", () => {
  function createExecutor(overrides: Record<string, unknown> = {}) {
    const mockDb = createMockDb();
    const mockCardService = createMockCardService();
    const mockExecSync = vi.fn().mockReturnValue(CLAUDE_REMOTE_OUTPUT);

    const executor = new RemoteExecutor({
      db: mockDb as never,
      eventBus: createMockEventBus(),
      logger: createMockLogger(),
      cardService: mockCardService as never,
      execSync: mockExecSync as never,
      ...overrides,
    });

    return { executor, mockDb, mockCardService, mockExecSync };
  }

  it("parses session ID and URL from claude --remote output", async () => {
    const { executor, mockDb, mockCardService, mockExecSync } = createExecutor();
    const card = { id: 1, repoId: 1, title: "Test", description: "Do stuff" };
    setupSelectReturning(mockDb, [card]);
    setupInsert(mockDb);

    await executor.startExecution(1);

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("claude --remote"),
      expect.objectContaining({ encoding: "utf-8" }),
    );
    expect(mockCardService.updateStatus).toHaveBeenCalledWith(1, "running");
    expect(mockCardService.logEvent).toHaveBeenCalledWith(
      1,
      "remote_session_created",
      expect.stringContaining("session_01CLmof84P5YY3MboTRacDLg"),
    );
  });

  it("creates workflow run with remote session metadata", async () => {
    const { executor, mockDb } = createExecutor();
    const card = { id: 1, repoId: 1, title: "Test", description: "Do stuff" };
    setupSelectReturning(mockDb, [card]);
    setupInsert(mockDb);

    await executor.startExecution(1);

    expect(mockDb.insert).toHaveBeenCalled();
  });

  it("marks card failed when claude --remote throws", async () => {
    const mockExecSync = vi.fn().mockImplementation(() => {
      throw new Error("command not found");
    });
    const { executor, mockDb, mockCardService } = createExecutor({
      execSync: mockExecSync as never,
    });
    const card = { id: 1, repoId: 1, title: "Test", description: "Do stuff" };
    setupSelectReturning(mockDb, [card]);

    await executor.startExecution(1);

    expect(mockCardService.updateStatus).toHaveBeenCalledWith(1, "failed");
    expect(mockCardService.logEvent).toHaveBeenCalledWith(
      1,
      "error",
      expect.stringContaining("claude --remote failed"),
    );
  });

  it("marks card failed when session ID cannot be parsed", async () => {
    const mockExecSync = vi.fn().mockReturnValue("some unexpected output\n");
    const { executor, mockDb, mockCardService } = createExecutor({
      execSync: mockExecSync as never,
    });
    const card = { id: 1, repoId: 1, title: "Test", description: "Do stuff" };
    setupSelectReturning(mockDb, [card]);

    await executor.startExecution(1);

    expect(mockCardService.updateStatus).toHaveBeenCalledWith(1, "failed");
    expect(mockCardService.logEvent).toHaveBeenCalledWith(
      1,
      "error",
      expect.stringContaining("Could not parse session ID"),
    );
  });

  it("marks card failed when no repoId", async () => {
    const { executor, mockDb, mockCardService } = createExecutor();
    const card = { id: 1, repoId: null, title: "Test" };
    setupSelectReturning(mockDb, [card]);

    await executor.startExecution(1);

    expect(mockCardService.updateStatus).toHaveBeenCalledWith(1, "failed");
  });

  it("uses card title when description is null", async () => {
    const { executor, mockDb, mockExecSync } = createExecutor();
    const card = { id: 1, repoId: 1, title: "Fix the bug", description: null };
    setupSelectReturning(mockDb, [card]);
    setupInsert(mockDb);

    await executor.startExecution(1);

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("Fix the bug"),
      expect.anything(),
    );
  });
});
