import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { WorkflowOrchestrator } from "../../server/domains/execution/workflow-orchestrator";
import { CardService } from "../../server/domains/cards/card-service";
import { cards } from "../../server/shared/db/schema";
import {
  db,
  cleanDb,
  seedBoard,
  seedRepo,
  seedCard,
  seedSlot,
  createTestEventBus,
  createNoopLogger,
  findEvents,
} from "../helpers/test-db";

/** Minimal tmux stub */
function createTmuxStub(opts: { isAvailable?: boolean } = {}) {
  const stopCaptureCalls: string[] = [];
  const killSessionCalls: string[] = [];
  return {
    isAvailable: () => opts.isAvailable ?? true,
    createSession: (_cardId: number, _cwd: string) => ({
      sessionName: `card-${_cardId}`,
      created: true,
    }),
    startCapture: (_name: string, _cb: (data: string) => void) => {},
    stopCapture: (name: string) => {
      stopCaptureCalls.push(name);
    },
    killSession: (name: string) => {
      killSessionCalls.push(name);
      return true;
    },
    stopCaptureCalls,
    killSessionCalls,
  };
}

describe("WorkflowOrchestrator", () => {
  let bus: ReturnType<typeof createTestEventBus>["bus"];
  let events: ReturnType<typeof createTestEventBus>["events"];
  let cardService: CardService;
  let boardId: number;
  let repoId: number;

  beforeEach(async () => {
    cleanDb();
    const board = await seedBoard();
    const repo = await seedRepo();
    boardId = board.id;
    repoId = repo.id;

    ({ bus, events } = createTestEventBus());
    cardService = new CardService({
      db,
      eventBus: bus,
      logger: createNoopLogger() as never,
    });
  });

  function createOrchestrator(
    opts: {
      tmuxAvailable?: boolean;
      workflow?: Record<string, unknown>;
      stepResults?: Array<{ passed: boolean; artifact?: string }>;
    } = {},
  ) {
    const tmux = createTmuxStub({ isAvailable: opts.tmuxAvailable });
    let stepCallIdx = 0;
    const stepResults = opts.stepResults ?? [{ passed: true, artifact: "content" }];
    const releasedSlotIds: number[] = [];

    return {
      orchestrator: new WorkflowOrchestrator({
        db,
        eventBus: bus,
        logger: createNoopLogger(),
        tmuxManager: tmux,
        slotAllocator: {
          claimSlot: async (rId: number, _cardId: number) => {
            const { workspaceSlots } = await import("../../server/shared/db/schema");
            const slots = await db.select().from(workspaceSlots);
            const available = slots.find((s) => s.repoId === rId && s.status === "available");
            return available ? { id: available.id, path: available.path } : null;
          },
          releaseSlot: async (slotId: number) => {
            releasedSlotIds.push(slotId);
          },
        },
        slotPreparer: {
          prepare: async () => ({
            branch: "ab/card-test",
            events: [],
            depsInstalled: false,
            packageManager: null,
          }),
          reset: async () => ({
            events: [],
            depsInstalled: false,
            packageManager: null,
          }),
        } as never,
        workflowLoader: {
          get: () =>
            opts.workflow ?? {
              name: "plan",
              steps: [{ id: "plan", prompt_template: "Plan", artifact: "plan.md" }],
              branch_template: "ab/card-{card_id}",
            },
        },
        contextBundler: { buildPrompt: () => "test prompt" },
        cardService,
        stepExecutor: {
          execute: async () => {
            const result = stepResults[stepCallIdx] ?? { passed: true };
            stepCallIdx++;
            return result;
          },
        } as never,
        streamTailer: {
          startTailing: async () => {},
          stopTailing: () => {},
          stopAll: () => {},
        },
        execSync: (() => "") as never,
        ttydManager: { isAvailable: () => false, attach: () => ({ port: 7700, url: "" }) } as never,
      }),
      tmux,
      releasedSlotIds,
    };
  }

  describe("initContext (via run)", () => {
    it("returns early when card not found", async () => {
      const { orchestrator } = createOrchestrator();

      await orchestrator.run(999);

      expect(findEvents(events, "workflow:completed")).toHaveLength(0);
    });

    it("marks failed when card has no repoId", async () => {
      const card = await seedCard(boardId, { repoId: null, workflowId: "plan", title: "Test" });
      const { orchestrator } = createOrchestrator();

      await orchestrator.run(card.id);

      const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
      expect(updated.status).toBe("failed");
    });

    it("marks failed when card has no workflowId", async () => {
      const card = await seedCard(boardId, { repoId, workflowId: null, title: "Test" });
      const { orchestrator } = createOrchestrator();

      await orchestrator.run(card.id);

      const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
      expect(updated.status).toBe("failed");
    });

    it("marks failed when workflow not found", async () => {
      const card = await seedCard(boardId, { repoId, workflowId: "nonexistent", title: "Test" });
      await seedSlot(repoId, { path: "/ws/slot-1" });

      createOrchestrator({ workflow: undefined as never });
      // Override workflowLoader to return undefined
      const orch2 = new WorkflowOrchestrator({
        db,
        eventBus: bus,
        logger: createNoopLogger(),
        tmuxManager: createTmuxStub(),
        slotAllocator: {
          claimSlot: async () => ({ id: 1, path: "/ws" }),
          releaseSlot: async () => {},
        },
        slotPreparer: {
          prepare: async () => ({
            branch: "",
            events: [],
            depsInstalled: false,
            packageManager: null,
          }),
          reset: async () => ({ events: [], depsInstalled: false, packageManager: null }),
        } as never,
        workflowLoader: { get: () => undefined },
        contextBundler: { buildPrompt: () => "" },
        cardService,
        stepExecutor: { execute: async () => ({ passed: true }) } as never,
        streamTailer: { startTailing: async () => {}, stopTailing: () => {}, stopAll: () => {} },
        execSync: (() => "") as never,
        ttydManager: { isAvailable: () => false, attach: () => ({ port: 7700, url: "" }) } as never,
      });

      await orch2.run(card.id);

      const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
      expect(updated.status).toBe("failed");
    });

    it("marks failed when tmux not available", async () => {
      const card = await seedCard(boardId, {
        repoId,
        workflowId: "plan",
        title: "Test",
        branchMode: "create",
        githubIssueNumber: 42,
      });
      await seedSlot(repoId, { path: "/ws/slot-1" });

      const { orchestrator } = createOrchestrator({ tmuxAvailable: false });

      await orchestrator.run(card.id);

      const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
      expect(updated.status).toBe("failed");
    });

    it("marks queued when no slots available", async () => {
      const card = await seedCard(boardId, {
        repoId,
        workflowId: "plan",
        title: "Test",
        branchMode: "create",
      });
      // No slots seeded

      const { orchestrator } = createOrchestrator();

      await orchestrator.run(card.id);

      const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
      expect(updated.status).toBe("queued");
    });
  });

  describe("step execution", () => {
    it("runs all steps in order when all pass", async () => {
      const card = await seedCard(boardId, {
        repoId,
        workflowId: "multi",
        title: "Test",
        branchMode: "create",
      });
      await seedSlot(repoId, { path: "/ws/slot-1" });

      const { orchestrator } = createOrchestrator({
        workflow: {
          name: "multi",
          steps: [
            { id: "plan", prompt_template: "Plan", artifact: "plan.md" },
            { id: "implement", prompt_template: "Implement", artifact: "impl.md" },
          ],
          branch_template: "ab/card-{card_id}",
        },
        stepResults: [
          { passed: true, artifact: "content" },
          { passed: true, artifact: "content" },
        ],
      });

      await orchestrator.run(card.id);

      const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
      expect(updated.status).toBe("review_ready");

      const completedEvents = findEvents(events, "workflow:completed");
      expect(completedEvents).toHaveLength(1);
      expect((completedEvents[0].data as { status: string }).status).toBe("completed");
    });

    it("stops on step failure", async () => {
      const card = await seedCard(boardId, {
        repoId,
        workflowId: "multi",
        title: "Test",
        branchMode: "create",
      });
      await seedSlot(repoId, { path: "/ws/slot-1" });

      const { orchestrator } = createOrchestrator({
        workflow: {
          name: "multi",
          steps: [
            { id: "plan", prompt_template: "Plan", artifact: "plan.md" },
            { id: "implement", prompt_template: "Implement", artifact: "impl.md" },
          ],
          branch_template: "ab/card-{card_id}",
        },
        stepResults: [{ passed: false }],
      });

      await orchestrator.run(card.id);

      const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
      expect(updated.status).toBe("failed");

      const completedEvents = findEvents(events, "workflow:completed");
      expect(completedEvents).toHaveLength(1);
      expect((completedEvents[0].data as { status: string }).status).toBe("failed");
    });
  });

  describe("cleanup", () => {
    it("cleans up in finally block (releases slot, kills tmux)", async () => {
      const card = await seedCard(boardId, {
        repoId,
        workflowId: "plan",
        title: "Test",
        branchMode: "create",
      });
      const slot = await seedSlot(repoId, { path: "/ws/slot-1" });

      const { orchestrator, tmux, releasedSlotIds } = createOrchestrator();

      await orchestrator.run(card.id);

      expect(tmux.stopCaptureCalls).toContain(`card-${card.id}`);
      expect(tmux.killSessionCalls).toContain(`card-${card.id}`);
      expect(releasedSlotIds).toContain(slot.id);
    });

    it("cleans up even when step throws", async () => {
      const card = await seedCard(boardId, {
        repoId,
        workflowId: "plan",
        title: "Test",
        branchMode: "create",
      });
      const slot = await seedSlot(repoId, { path: "/ws/slot-1" });

      const tmux = createTmuxStub();
      const releasedSlotIds: number[] = [];

      const orchestrator = new WorkflowOrchestrator({
        db,
        eventBus: bus,
        logger: createNoopLogger(),
        tmuxManager: tmux,
        slotAllocator: {
          claimSlot: async () => ({ id: slot.id, path: slot.path }),
          releaseSlot: async (id: number) => {
            releasedSlotIds.push(id);
          },
        },
        slotPreparer: {
          prepare: async () => ({
            branch: "ab/test",
            events: [],
            depsInstalled: false,
            packageManager: null,
          }),
          reset: async () => ({ events: [], depsInstalled: false, packageManager: null }),
        } as never,
        workflowLoader: {
          get: () => ({
            name: "plan",
            steps: [{ id: "plan", prompt_template: "Plan", artifact: "plan.md" }],
            branch_template: "ab/card-{card_id}",
          }),
        },
        contextBundler: { buildPrompt: () => "" },
        cardService,
        stepExecutor: {
          execute: async () => {
            throw new Error("boom");
          },
        } as never,
        streamTailer: { startTailing: async () => {}, stopTailing: () => {}, stopAll: () => {} },
        execSync: (() => "") as never,
        ttydManager: { isAvailable: () => false, attach: () => ({ port: 7700, url: "" }) } as never,
      });

      await orchestrator.run(card.id);

      expect(tmux.killSessionCalls).toContain(`card-${card.id}`);
      expect(releasedSlotIds).toContain(slot.id);

      const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
      expect(updated.status).toBe("failed");
    });
  });
});
