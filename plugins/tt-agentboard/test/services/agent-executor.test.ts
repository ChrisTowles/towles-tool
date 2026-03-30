import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { AgentExecutor } from "../../server/domains/execution/agent-executor";
import { CardService } from "../../server/domains/cards/card-service";
import { cards, workspaceSlots } from "../../server/shared/db/schema";
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
  createTmuxStub,
} from "../helpers/test-db";
import type { TestBus, TestEvents } from "../helpers/test-db";

describe("AgentExecutor", () => {
  let bus: TestBus;
  let events: TestEvents;
  let cardService: CardService;
  let boardId: number;
  let repoId: number;
  let orchestratorRuns: number[];
  let remoteExecutorRuns: number[];

  beforeEach(async () => {
    cleanDb();
    const board = await seedBoard();
    const repo = await seedRepo();
    boardId = board.id;
    repoId = repo.id;
    orchestratorRuns = [];
    remoteExecutorRuns = [];

    ({ bus, events } = createTestEventBus());
    cardService = new CardService({
      db,
      eventBus: bus,
      logger: createNoopLogger() as never,
    });
  });

  function createExecutor(
    opts: {
      tmuxAvailable?: boolean;
      writeFileCalls?: Array<{ path: string; content: string }>;
      writeHooksCalls?: Array<{ slotPath: string; cardId: number }>;
      workflowLoader?: { get: (id: string) => unknown };
    } = {},
  ) {
    const tmux = createTmuxStub({ isAvailable: opts.tmuxAvailable });
    const writeFileCalls = opts.writeFileCalls ?? [];
    const writeHooksCalls = opts.writeHooksCalls ?? [];

    return {
      executor: new AgentExecutor(4200, {
        db,
        eventBus: bus,
        logger: createNoopLogger(),
        tmuxManager: tmux,
        slotAllocator: {
          claimSlot: async (rId: number) => {
            const slots = await db.select().from(workspaceSlots);
            const available = slots.find((s) => s.repoId === rId && s.status === "available");
            return available ? { id: available.id, path: available.path } : null;
          },
          releaseSlot: async () => {},
          getSlotForCard: async () => null,
        },
        slotPreparer: {
          prepare: async () => ({
            branch: "agentboard/card-test",
            events: [],
            depsInstalled: false,
            packageManager: null,
          }),
          reset: async () => ({ events: [], depsInstalled: false, packageManager: null }),
        } as never,
        workflowLoader: opts.workflowLoader ?? { get: () => null },
        workflowOrchestrator: {
          run: async (cardId: number) => {
            orchestratorRuns.push(cardId);
          },
        },
        writeHooks: ((slotPath: string, cardId: number) => {
          writeHooksCalls.push({ slotPath, cardId });
        }) as never,
        cardService,
        mkdirSync: (() => {}) as never,
        writeFileSync: ((path: string, content: string) => {
          writeFileCalls.push({ path, content });
        }) as never,
        ttydManager: {
          isAvailable: () => false,
          attach: () => ({ port: 7700, url: "" }),
        } as never,
        remoteExecutor: {
          startExecution: async (cardId: number) => {
            remoteExecutorRuns.push(cardId);
          },
        },
      }),
      tmux,
    };
  }

  describe("startExecution()", () => {
    it("returns early when card not found", async () => {
      const { executor } = createExecutor();
      await executor.startExecution(999);
      expect(findEvents(events, "card:status-changed")).toHaveLength(0);
    });

    it("marks failed when card has no repoId", async () => {
      const card = await seedCard(boardId, { repoId: null, title: "Test" });
      const { executor } = createExecutor();

      await executor.startExecution(card.id);

      const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
      expect(updated.status).toBe("failed");
    });

    it("delegates to workflowOrchestrator when card has valid workflow", async () => {
      const card = await seedCard(boardId, { repoId, workflowId: "plan", title: "Test" });
      const { executor } = createExecutor({
        workflowLoader: { get: () => ({ name: "plan", steps: [] }) },
      });

      await executor.startExecution(card.id);

      expect(orchestratorRuns).toEqual([card.id]);
    });

    it("delegates to remoteExecutor when executionMode is remote", async () => {
      const card = await seedCard(boardId, { repoId, title: "Test", executionMode: "remote" });
      const { executor } = createExecutor();

      await executor.startExecution(card.id);

      expect(remoteExecutorRuns).toEqual([card.id]);
    });

    it("falls back to single prompt when workflow not found", async () => {
      const card = await seedCard(boardId, {
        repoId,
        workflowId: "nonexistent",
        title: "Test Card",
        description: "Do something",
        executionMode: "headless",
      });
      await seedSlot(repoId, { path: "/workspace/slot-1" });

      const { executor, tmux } = createExecutor();

      await executor.startExecution(card.id);

      expect(orchestratorRuns).toHaveLength(0);
      expect(tmux.sendCommandCalls.length).toBeGreaterThan(0);
      expect(tmux.sendCommandCalls[0].cmd).toContain("@");
      expect(tmux.sendCommandCalls[0].cmd).toContain(`card-${card.id}-prompt.md`);
    });

    it("marks queued when no slots available", async () => {
      const card = await seedCard(boardId, { repoId, title: "Test", executionMode: "headless" });
      const { executor } = createExecutor();

      await executor.startExecution(card.id);

      const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
      expect(updated.status).toBe("queued");
    });

    it("marks failed when tmux not available", async () => {
      const card = await seedCard(boardId, { repoId, title: "Test", executionMode: "headless" });
      const { executor } = createExecutor({ tmuxAvailable: false });

      await executor.startExecution(card.id);

      const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
      expect(updated.status).toBe("failed");
    });

    it("writes hooks and starts capture on successful single-prompt", async () => {
      const card = await seedCard(boardId, {
        repoId,
        title: "Test Card",
        description: "Implement feature",
        executionMode: "headless",
      });
      await seedSlot(repoId, { path: "/workspace/slot-1" });

      const writeHooksCalls: Array<{ slotPath: string; cardId: number }> = [];
      const { executor, tmux } = createExecutor({ writeHooksCalls });

      await executor.startExecution(card.id);

      expect(writeHooksCalls).toHaveLength(1);
      expect(writeHooksCalls[0].slotPath).toBe("/workspace/slot-1");
      expect(writeHooksCalls[0].cardId).toBe(card.id);

      expect(tmux.sendCommandCalls.length).toBeGreaterThan(0);
      const cmd = tmux.sendCommandCalls[0].cmd;
      expect(cmd).toContain("@");
      expect(cmd).toContain(`card-${card.id}-prompt.md`);
    });

    it("writes prompt file for non-interactive mode", async () => {
      const card = await seedCard(boardId, {
        repoId,
        title: "Test",
        description: "do stuff",
        executionMode: "headless",
      });
      await seedSlot(repoId, { path: "/workspace/slot-1" });

      const writeFileCalls: Array<{ path: string; content: string }> = [];
      const { executor } = createExecutor({ writeFileCalls });

      await executor.startExecution(card.id);

      const promptWrite = writeFileCalls.find((c) => c.path.includes("card-"));
      expect(promptWrite).toBeDefined();
      expect(promptWrite!.content).toBe("do stuff");
    });

    it("uses interactive claude for interactive mode", async () => {
      const card = await seedCard(boardId, {
        repoId,
        title: "Test",
        description: "do stuff",
        executionMode: "interactive",
      });
      await seedSlot(repoId, { path: "/workspace/slot-1" });

      const { executor, tmux } = createExecutor();

      await executor.startExecution(card.id);

      expect(tmux.sendCommandCalls[0].cmd).toBe("claude");
    });

    it("uses card title as prompt when description is null", async () => {
      const card = await seedCard(boardId, {
        repoId,
        title: "Fix the bug",
        description: null,
        executionMode: "headless",
      });
      await seedSlot(repoId, { path: "/workspace/slot-1" });

      const writeFileCalls: Array<{ path: string; content: string }> = [];
      const { executor } = createExecutor({ writeFileCalls });

      await executor.startExecution(card.id);

      const promptWrite = writeFileCalls.find((c) => c.path.includes(`card-${card.id}-prompt.md`));
      expect(promptWrite).toBeDefined();
      expect(promptWrite!.content).toBe("Fix the bug");
    });
  });
});
