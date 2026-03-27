import { describe, it, expect, vi, beforeEach } from "vitest";

import { StepExecutor, resolveStepComplete } from "../../server/domains/execution/step-executor";
import type { WorkflowContext } from "../../server/domains/execution/step-executor";
import type { WorkflowStep } from "../../server/domains/execution/workflow-loader";
import {
  createMockDb,
  createMockEventBus,
  createMockLogger,
  createMockContextBundler,
  createMockCardService,
  createMockStreamTailer,
} from "../helpers/mock-deps";
import type { MockDb } from "../helpers/mock-deps";

function makeStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id: "plan",
    prompt_template: "Do the thing",
    artifact: "artifacts/{card_id}-plan.md",
    ...overrides,
  };
}

function makeContext(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return {
    cardId: 1,
    card: { id: 1, githubIssueNumber: 42, title: "Test card" },
    repo: { id: 1, name: "test-repo" },
    workflow: { steps: [], branch_template: "ab/card-{card_id}" },
    slotPath: "/workspace/slot-1",
    slotId: 1,
    sessionName: "card-1",
    workflowRunId: 1,
    branch: "ab/card-1",
    previousArtifacts: new Map(),
    ...overrides,
  };
}

describe("StepExecutor", () => {
  let executor: StepExecutor;
  let mockDb: MockDb;
  let mockEventBus: ReturnType<typeof createMockEventBus>;
  let mockCardService: ReturnType<typeof createMockCardService>;
  let mockExistsSync: ReturnType<typeof vi.fn>;
  let mockReadFileSync: ReturnType<typeof vi.fn>;
  let mockStreamTailer: ReturnType<typeof createMockStreamTailer>;

  beforeEach(() => {
    mockDb = createMockDb();
    mockEventBus = createMockEventBus();
    mockCardService = createMockCardService();
    mockExistsSync = vi.fn().mockReturnValue(true);
    mockReadFileSync = vi.fn().mockReturnValue("PASS\ndetails");
    mockStreamTailer = createMockStreamTailer();

    executor = new StepExecutor(4200, {
      db: mockDb as never,
      eventBus: mockEventBus,
      logger: createMockLogger(),
      tmuxManager: { sendCommand: vi.fn() },
      contextBundler: createMockContextBundler(),
      writeHooks: vi.fn(),
      cardService: mockCardService as never,
      streamTailer: mockStreamTailer,
      existsSync: mockExistsSync as never,
      readFileSync: mockReadFileSync as never,
    });
    vi.clearAllMocks();
  });

  it("passes on first attempt when artifact exists and no pass_condition", async () => {
    // Arrange: resolveStepComplete fires immediately after waitForStepComplete is set up
    // We use a microtask to resolve the callback right after execute starts waiting
    const originalExecute = executor.execute.bind(executor);
    const executePromise = originalExecute(makeContext(), makeStep(), new Map());

    // Resolve the pending callback shortly after
    await vi.waitFor(() => {
      const resolved = resolveStepComplete(1);
      expect(resolved).toBe(true);
    });

    const result = await executePromise;

    expect(result.passed).toBe(true);
    expect(result.artifact).toBe("PASS\ndetails");
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      "step:started",
      expect.objectContaining({ cardId: 1, stepId: "plan" }),
    );
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      "step:completed",
      expect.objectContaining({ cardId: 1, stepId: "plan", passed: true }),
    );
  });

  it("passes when artifact exists and pass_condition is met", async () => {
    const step = makeStep({ pass_condition: "first_line_equals:PASS" });
    mockReadFileSync.mockReturnValue("PASS\ndetails");

    const executePromise = executor.execute(makeContext(), step, new Map());

    await vi.waitFor(() => {
      expect(resolveStepComplete(1)).toBe(true);
    });

    const result = await executePromise;
    expect(result.passed).toBe(true);
  });

  it("fails when artifact is missing after Claude exits", async () => {
    mockExistsSync.mockReturnValue(false);

    const executePromise = executor.execute(makeContext(), makeStep(), new Map());

    await vi.waitFor(() => {
      expect(resolveStepComplete(1)).toBe(true);
    });

    const result = await executePromise;
    expect(result.passed).toBe(false);
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      "step:failed",
      expect.objectContaining({ cardId: 1, stepId: "plan" }),
    );
  });

  it("fails when pass_condition is not met", async () => {
    const step = makeStep({ pass_condition: "first_line_equals:PASS" });
    mockReadFileSync.mockReturnValue("FAIL\ndetails");

    const executePromise = executor.execute(makeContext(), step, new Map());

    await vi.waitFor(() => {
      expect(resolveStepComplete(1)).toBe(true);
    });

    const result = await executePromise;
    expect(result.passed).toBe(false);
  });

  it("retries up to max_retries on failure", async () => {
    const step = makeStep({ max_retries: 1, pass_condition: "first_line_equals:PASS" });
    // First attempt fails, second passes
    let callCount = 0;
    mockReadFileSync.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? "FAIL\nretry needed" : "PASS\nsuccess";
    });

    const executePromise = executor.execute(makeContext(), step, new Map());

    // Resolve first attempt
    await vi.waitFor(() => {
      expect(resolveStepComplete(1)).toBe(true);
    });

    // Resolve second attempt (retry)
    await vi.waitFor(() => {
      expect(resolveStepComplete(1)).toBe(true);
    });

    const result = await executePromise;
    expect(result.passed).toBe(true);
    // step:failed should have been emitted once for the first failed attempt
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      "step:failed",
      expect.objectContaining({ retryNumber: 0 }),
    );
  });

  it("stores artifact content in previousArtifacts map", async () => {
    const artifacts = new Map<string, string>();
    mockReadFileSync.mockReturnValue("plan content here");

    const executePromise = executor.execute(makeContext(), makeStep(), artifacts);

    await vi.waitFor(() => {
      expect(resolveStepComplete(1)).toBe(true);
    });

    await executePromise;
    expect(artifacts.get("plan")).toBe("plan content here");
  });
});

describe("resolveStepComplete()", () => {
  it("returns false when no pending callback exists", () => {
    expect(resolveStepComplete(999)).toBe(false);
  });
});
