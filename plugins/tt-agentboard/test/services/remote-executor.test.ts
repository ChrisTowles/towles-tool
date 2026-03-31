import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { RemoteExecutor } from "../../server/domains/execution/remote-executor";
import { CardService } from "../../server/domains/cards/card-service";
import { cards, cardEvents, workflowRuns } from "../../server/shared/db/schema";
import {
  db,
  cleanDb,
  seedBoard,
  seedRepo,
  seedCard,
  createTestEventBus,
  createNoopLogger,
} from "../helpers/test-db";
import type { TestBus } from "../helpers/test-db";

const CLAUDE_REMOTE_OUTPUT = `Created remote session: Test implementation and validation
View: https://claude.ai/code/session_01CLmof84P5YY3MboTRacDLg?m=0
Resume with: claude --teleport session_01CLmof84P5YY3MboTRacDLg
`;

describe("RemoteExecutor", () => {
  let bus: TestBus;
  let cardService: CardService;
  let boardId: number;
  let repoId: number;

  beforeEach(async () => {
    cleanDb();
    const board = await seedBoard();
    const repo = await seedRepo();
    boardId = board.id;
    repoId = repo.id;

    ({ bus } = createTestEventBus());
    cardService = new CardService({
      db,
      eventBus: bus,
      logger: createNoopLogger() as never,
    });
  });

  function createExecutor(execFn: (...args: unknown[]) => Promise<{ stdout: string; exitCode: number }>) {
    return new RemoteExecutor({
      db,
      eventBus: bus,
      logger: createNoopLogger(),
      cardService,
      exec: execFn as never,
    });
  }

  it("parses session ID and URL from claude --remote output", async () => {
    const card = await seedCard(boardId, { repoId, title: "Test", description: "Do stuff" });
    const executor = createExecutor(async () => ({ stdout: CLAUDE_REMOTE_OUTPUT, exitCode: 0 }));

    await executor.startExecution(card.id);

    const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
    expect(updated.status).toBe("running");

    const logRows = await db.select().from(cardEvents).where(eq(cardEvents.cardId, card.id));
    const sessionCreated = logRows.find((e) => e.event === "remote_session_created");
    expect(sessionCreated).toBeDefined();
    expect(sessionCreated!.detail).toContain("session_01CLmof84P5YY3MboTRacDLg");
  });

  it("creates workflow run with remote session metadata", async () => {
    const card = await seedCard(boardId, { repoId, title: "Test", description: "Do stuff" });
    const executor = createExecutor(async () => ({ stdout: CLAUDE_REMOTE_OUTPUT, exitCode: 0 }));

    await executor.startExecution(card.id);

    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.cardId, card.id));
    expect(runs).toHaveLength(1);
    expect(runs[0].remoteSessionId).toBe("session_01CLmof84P5YY3MboTRacDLg");
  });

  it("marks card failed when claude --remote throws", async () => {
    const card = await seedCard(boardId, { repoId, title: "Test", description: "Do stuff" });
    const executor = createExecutor(async () => {
      throw new Error("command not found");
    });

    await executor.startExecution(card.id);

    const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
    expect(updated.status).toBe("failed");

    const logRows = await db.select().from(cardEvents).where(eq(cardEvents.cardId, card.id));
    const errorLog = logRows.find((e) => e.event === "error");
    expect(errorLog).toBeDefined();
    expect(errorLog!.detail).toContain("claude --remote failed");
  });

  it("marks card failed when session ID cannot be parsed", async () => {
    const card = await seedCard(boardId, { repoId, title: "Test", description: "Do stuff" });
    const executor = createExecutor(async () => ({ stdout: "some unexpected output\n", exitCode: 0 }));

    await executor.startExecution(card.id);

    const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
    expect(updated.status).toBe("failed");

    const logRows = await db.select().from(cardEvents).where(eq(cardEvents.cardId, card.id));
    const errorLog = logRows.find((e) => e.event === "error");
    expect(errorLog!.detail).toContain("Could not parse session ID");
  });

  it("marks card failed when no repoId", async () => {
    const card = await seedCard(boardId, { repoId: null, title: "Test" });
    const executor = createExecutor(async () => ({ stdout: CLAUDE_REMOTE_OUTPUT, exitCode: 0 }));

    await executor.startExecution(card.id);

    const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
    expect(updated.status).toBe("failed");
  });

  it("uses card title when description is null", async () => {
    const card = await seedCard(boardId, { repoId, title: "Fix the bug", description: null });
    let capturedArgs: unknown[] = [];
    const executor = createExecutor(async (...args: unknown[]) => {
      capturedArgs = args;
      return { stdout: CLAUDE_REMOTE_OUTPUT, exitCode: 0 };
    });

    await executor.startExecution(card.id);

    expect(capturedArgs[1]).toContain("Fix the bug");
  });
});
