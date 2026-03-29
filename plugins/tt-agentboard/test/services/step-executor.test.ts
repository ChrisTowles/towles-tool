import { describe, it, expect, vi, beforeEach } from "vitest";
import { StepExecutor, resolveStepComplete } from "../../server/domains/execution/step-executor";
import type { WorkflowContext } from "../../server/domains/execution/step-executor";
import type { WorkflowStep } from "../../server/domains/execution/workflow-loader";
import {
  db,
  cleanDb,
  seedBoard,
  seedRepo,
  seedCard,
  seedSlot,
  seedWorkflowRun,
  createTestEventBus,
  createNoopLogger,
  findEvents,
} from "../helpers/test-db";

function makeStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id: "plan",
    prompt_template: "Do the thing",
    artifact: "artifacts/{card_id}-plan.md",
    ...overrides,
  };
}

describe("StepExecutor", () => {
  let bus: ReturnType<typeof createTestEventBus>["bus"];
  let events: ReturnType<typeof createTestEventBus>["events"];
  let existsSyncReturn: boolean;
  let readFileSyncReturn: string;
  let ctx: WorkflowContext;

  beforeEach(async () => {
    cleanDb();
    existsSyncReturn = true;
    readFileSyncReturn = "PASS\ndetails";

    ({ bus, events } = createTestEventBus());

    // Seed real data for the context
    const board = await seedBoard();
    const repo = await seedRepo();
    const card = await seedCard(board.id, {
      repoId: repo.id,
      title: "Test card",
      githubIssueNumber: 42,
    });
    const slot = await seedSlot(repo.id, { path: "/workspace/slot-1" });
    const run = await seedWorkflowRun(card.id, { slotId: slot.id });

    ctx = {
      cardId: card.id,
      card: { id: card.id, githubIssueNumber: 42, title: "Test card" },
      repo: { id: repo.id, name: "test-repo" },
      workflow: { steps: [], branch_template: "ab/card-{card_id}" },
      slotPath: "/workspace/slot-1",
      slotId: slot.id,
      sessionName: `card-${card.id}`,
      workflowRunId: run.id,
      branch: `ab/card-${card.id}`,
      previousArtifacts: new Map(),
    };
  });

  function createExecutor(overrides: {
    existsSyncFn?: () => boolean;
    readFileSyncFn?: () => string;
  } = {}) {
    return new StepExecutor(4200, {
      db,
      eventBus: bus,
      logger: createNoopLogger(),
      tmuxManager: { sendCommand: () => {} },
      contextBundler: { buildPrompt: () => "test prompt" },
      writeHooks: () => {},
      cardService: {
        updateStatus: async () => {},
        moveToColumn: async () => {},
        markFailed: async () => {},
        markComplete: async () => {},
        logEvent: async () => {},
        resolveDependencies: async () => [],
        getDepsMap: async () => new Map(),
      } as never,
      streamTailer: { startTailing: async () => {}, stopTailing: () => {}, stopAll: () => {} },
      existsSync: (overrides.existsSyncFn ?? (() => existsSyncReturn)) as never,
      readFileSync: (overrides.readFileSyncFn ?? (() => readFileSyncReturn)) as never,
    });
  }

  it("passes on first attempt when artifact exists and no pass_condition", async () => {
    const executor = createExecutor();

    const executePromise = executor.execute(ctx, makeStep(), new Map());

    await vi.waitFor(() => {
      const resolved = resolveStepComplete(ctx.cardId);
      expect(resolved).toBe(true);
    });

    const result = await executePromise;

    expect(result.passed).toBe(true);
    expect(result.artifact).toBe("PASS\ndetails");

    const startedEvents = findEvents(events, "step:started");
    expect(startedEvents).toHaveLength(1);
    expect((startedEvents[0].data as { stepId: string }).stepId).toBe("plan");

    const completedEvents = findEvents(events, "step:completed");
    expect(completedEvents).toHaveLength(1);
    expect((completedEvents[0].data as { passed: boolean }).passed).toBe(true);
  });

  it("passes when artifact exists and pass_condition is met", async () => {
    readFileSyncReturn = "PASS\ndetails";
    const executor = createExecutor();
    const step = makeStep({ pass_condition: "first_line_equals:PASS" });

    const executePromise = executor.execute(ctx, step, new Map());

    await vi.waitFor(() => {
      expect(resolveStepComplete(ctx.cardId)).toBe(true);
    });

    const result = await executePromise;
    expect(result.passed).toBe(true);
  });

  it("fails when artifact is missing after Claude exits", async () => {
    existsSyncReturn = false;
    const executor = createExecutor();

    const executePromise = executor.execute(ctx, makeStep(), new Map());

    await vi.waitFor(() => {
      expect(resolveStepComplete(ctx.cardId)).toBe(true);
    });

    const result = await executePromise;
    expect(result.passed).toBe(false);

    const failedEvents = findEvents(events, "step:failed");
    expect(failedEvents).toHaveLength(1);
  });

  it("fails when pass_condition is not met", async () => {
    readFileSyncReturn = "FAIL\ndetails";
    const executor = createExecutor();
    const step = makeStep({ pass_condition: "first_line_equals:PASS" });

    const executePromise = executor.execute(ctx, step, new Map());

    await vi.waitFor(() => {
      expect(resolveStepComplete(ctx.cardId)).toBe(true);
    });

    const result = await executePromise;
    expect(result.passed).toBe(false);
  });

  it("retries up to max_retries on failure", async () => {
    let callCount = 0;
    const executor = createExecutor({
      readFileSyncFn: () => {
        callCount++;
        return callCount === 1 ? "FAIL\nretry needed" : "PASS\nsuccess";
      },
    });

    const step = makeStep({ max_retries: 1, pass_condition: "first_line_equals:PASS" });
    const executePromise = executor.execute(ctx, step, new Map());

    // Resolve first attempt
    await vi.waitFor(() => {
      expect(resolveStepComplete(ctx.cardId)).toBe(true);
    });

    // Resolve second attempt (retry)
    await vi.waitFor(() => {
      expect(resolveStepComplete(ctx.cardId)).toBe(true);
    });

    const result = await executePromise;
    expect(result.passed).toBe(true);

    const failedEvents = findEvents(events, "step:failed");
    expect(failedEvents).toHaveLength(1);
    expect((failedEvents[0].data as { retryNumber: number }).retryNumber).toBe(0);
  });

  it("stores artifact content in previousArtifacts map", async () => {
    readFileSyncReturn = "plan content here";
    const executor = createExecutor();
    const artifacts = new Map<string, string>();

    const executePromise = executor.execute(ctx, makeStep(), artifacts);

    await vi.waitFor(() => {
      expect(resolveStepComplete(ctx.cardId)).toBe(true);
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
