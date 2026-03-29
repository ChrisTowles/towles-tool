import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { AgentExecutor } from "../../server/domains/execution/agent-executor";
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

/** Minimal tmux stub for tests (system boundary — must use manual DI) */
function createTmuxStub(overrides: {
  isAvailable?: boolean;
  sendCommandCalls?: Array<{ session: string; cmd: string }>;
} = {}) {
  const sendCommandCalls = overrides.sendCommandCalls ?? [];
  return {
    isAvailable: () => overrides.isAvailable ?? true,
    createSession: (_cardId: number, _cwd: string) => ({
      sessionName: `card-${_cardId}`,
      created: true,
    }),
    startCapture: (_name: string, _cb: (data: string) => void) => {},
    stopCapture: (_name: string) => {},
    killSession: (_name: string) => true,
    sendCommand: (session: string, cmd: string) => {
      sendCommandCalls.push({ session, cmd });
    },
  };
}

describe("AgentExecutor", () => {
  let bus: ReturnType<typeof createTestEventBus>["bus"];
  let events: ReturnType<typeof createTestEventBus>["events"];
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

  function createExecutor(opts: {
    tmuxAvailable?: boolean;
    sendCommandCalls?: Array<{ session: string; cmd: string }>;
    writeFileCalls?: Array<{ path: string; content: string }>;
    writeHooksCalls?: Array<{ slotPath: string; cardId: number }>;
  } = {}) {
    const sendCommandCalls = opts.sendCommandCalls ?? [];
    const writeFileCalls = opts.writeFileCalls ?? [];
    const writeHooksCalls = opts.writeHooksCalls ?? [];

    return new AgentExecutor(4200, {
      db,
      eventBus: bus,
      logger: createNoopLogger(),
      tmuxManager: createTmuxStub({
        isAvailable: opts.tmuxAvailable,
        sendCommandCalls,
      }),
      slotAllocator: {
        claimSlot: async (rId: number, cardId: number) => {
          // Find an available slot in the DB for the repo
          const slots = await db.select().from(
            (await import("../../server/shared/db/schema")).workspaceSlots,
          );
          const available = slots.find(
            (s) => s.repoId === rId && s.status === "available",
          );
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
        reset: async () => ({
          events: [],
          depsInstalled: false,
          packageManager: null,
        }),
      } as never,
      workflowLoader: { get: () => null },
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
      ttydManager: { isAvailable: () => false, attach: () => ({ port: 7700, url: "" }) } as never,
      remoteExecutor: {
        startExecution: async (cardId: number) => {
          remoteExecutorRuns.push(cardId);
        },
      },
    });
  }

  describe("startExecution()", () => {
    it("returns early when card not found", async () => {
      const executor = createExecutor();

      await executor.startExecution(999);

      // No status change events
      expect(findEvents(events, "card:status-changed")).toHaveLength(0);
    });

    it("marks failed when card has no repoId", async () => {
      const card = await seedCard(boardId, { repoId: null, title: "Test" });
      const executor = createExecutor();

      await executor.startExecution(card.id);

      const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
      expect(updated.status).toBe("failed");
    });

    it("delegates to workflowOrchestrator when card has valid workflow", async () => {
      const card = await seedCard(boardId, { repoId, workflowId: "plan", title: "Test" });
      const executor = new AgentExecutor(4200, {
        db,
        eventBus: bus,
        logger: createNoopLogger(),
        tmuxManager: createTmuxStub(),
        slotAllocator: { claimSlot: async () => null, releaseSlot: async () => {}, getSlotForCard: async () => null },
        slotPreparer: { prepare: async () => ({ branch: "", events: [], depsInstalled: false, packageManager: null }), reset: async () => ({ events: [], depsInstalled: false, packageManager: null }) } as never,
        workflowLoader: { get: () => ({ name: "plan", steps: [] }) },
        workflowOrchestrator: { run: async (cid: number) => { orchestratorRuns.push(cid); } },
        writeHooks: (() => {}) as never,
        cardService,
        mkdirSync: (() => {}) as never,
        writeFileSync: (() => {}) as never,
        ttydManager: { isAvailable: () => false, attach: () => ({ port: 7700, url: "" }) } as never,
        remoteExecutor: { startExecution: async () => {} },
      });

      await executor.startExecution(card.id);

      expect(orchestratorRuns).toEqual([card.id]);
    });

    it("delegates to remoteExecutor when executionMode is remote", async () => {
      const card = await seedCard(boardId, {
        repoId,
        title: "Test",
        executionMode: "remote",
      });
      const executor = createExecutor();

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

      const sendCommandCalls: Array<{ session: string; cmd: string }> = [];
      const executor = createExecutor({ sendCommandCalls });

      await executor.startExecution(card.id);

      expect(orchestratorRuns).toHaveLength(0);
      expect(sendCommandCalls.length).toBeGreaterThan(0);
      expect(sendCommandCalls[0].cmd).toContain("@");
      expect(sendCommandCalls[0].cmd).toContain(`card-${card.id}-prompt.md`);
    });

    it("marks queued when no slots available", async () => {
      const card = await seedCard(boardId, {
        repoId,
        title: "Test",
        executionMode: "headless",
      });
      // No slots seeded
      const executor = createExecutor();

      await executor.startExecution(card.id);

      const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
      expect(updated.status).toBe("queued");
    });

    it("marks failed when tmux not available", async () => {
      const card = await seedCard(boardId, {
        repoId,
        title: "Test",
        executionMode: "headless",
      });
      const executor = createExecutor({ tmuxAvailable: false });

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
      const sendCommandCalls: Array<{ session: string; cmd: string }> = [];
      const executor = createExecutor({ writeHooksCalls, sendCommandCalls });

      await executor.startExecution(card.id);

      expect(writeHooksCalls).toHaveLength(1);
      expect(writeHooksCalls[0].slotPath).toBe("/workspace/slot-1");
      expect(writeHooksCalls[0].cardId).toBe(card.id);

      expect(sendCommandCalls.length).toBeGreaterThan(0);
      const cmd = sendCommandCalls[0].cmd;
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
      const executor = createExecutor({ writeFileCalls });

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

      const sendCommandCalls: Array<{ session: string; cmd: string }> = [];
      const executor = createExecutor({ sendCommandCalls });

      await executor.startExecution(card.id);

      expect(sendCommandCalls[0].cmd).toBe("claude");
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
      const executor = createExecutor({ writeFileCalls });

      await executor.startExecution(card.id);

      const promptWrite = writeFileCalls.find((c) =>
        c.path.includes(`card-${card.id}-prompt.md`),
      );
      expect(promptWrite).toBeDefined();
      expect(promptWrite!.content).toBe("Fix the bug");
    });
  });
});
