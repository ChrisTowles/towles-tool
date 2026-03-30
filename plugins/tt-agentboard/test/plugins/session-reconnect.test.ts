import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createSessionReconnect } from "../../server/plugins/session-reconnect";
import { CardService } from "../../server/domains/cards/card-service";
import { cards } from "../../server/shared/db/schema";
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

describe("Session Reconnect Plugin", () => {
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

  function runPlugin(tmux: {
    isAvailable?: boolean;
    sessions?: string[];
    sessionExists?: (name: string) => boolean;
    startCaptureCalls?: Array<{ name: string }>;
    killSessionCalls?: string[];
  }) {
    const killSessionCalls = tmux.killSessionCalls ?? [];
    const startCaptureCalls = tmux.startCaptureCalls ?? [];

    return createSessionReconnect({
      db: db as never,
      tmuxManager: {
        isAvailable: () => tmux.isAvailable ?? true,
        listSessions: () => tmux.sessions ?? [],
        sessionExists: tmux.sessionExists ?? (() => true),
        startCapture: (name: string, _onOutput: (output: string) => void) => {
          startCaptureCalls.push({ name });
        },
        killSession: (name: string) => {
          killSessionCalls.push(name);
        },
      },
      eventBus: bus as never,
      logger: createNoopLogger() as never,
      cardService,
    });
  }

  it("skips when tmux not available", async () => {
    await runPlugin({ isAvailable: false });
    // No errors, just returns early
  });

  it("no action when no orphaned sessions", async () => {
    const killCalls: string[] = [];
    await runPlugin({ sessions: [], killSessionCalls: killCalls });
    expect(killCalls).toHaveLength(0);
  });

  it("kills session when card not found in DB", async () => {
    const killCalls: string[] = [];
    await runPlugin({
      sessions: ["card-99"],
      killSessionCalls: killCalls,
    });
    expect(killCalls).toContain("card-99");
  });

  it("kills session when card is not running", async () => {
    const card = await seedCard(boardId, { repoId, status: "done" });

    const killCalls: string[] = [];
    await runPlugin({
      sessions: [`card-${card.id}`],
      killSessionCalls: killCalls,
    });
    expect(killCalls).toContain(`card-${card.id}`);
  });

  it("resumes capture for running card with live session", async () => {
    const card = await seedCard(boardId, { repoId, status: "running" });

    const startCaptureCalls: Array<{ name: string }> = [];
    const killCalls: string[] = [];
    await runPlugin({
      sessions: [`card-${card.id}`],
      sessionExists: () => true,
      startCaptureCalls,
      killSessionCalls: killCalls,
    });

    expect(startCaptureCalls).toHaveLength(1);
    expect(startCaptureCalls[0].name).toBe(`card-${card.id}`);
    expect(killCalls).toHaveLength(0);
  });

  it("marks card failed when session died between list and check", async () => {
    const card = await seedCard(boardId, { repoId, status: "running" });

    await runPlugin({
      sessions: [`card-${card.id}`],
      sessionExists: () => false,
    });

    const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
    expect(updated.status).toBe("failed");
  });

  it("marks running card failed when it has no live tmux session", async () => {
    // A card that's "done" in a tmux session, and another running without session
    const doneCard = await seedCard(boardId, { repoId, status: "done", title: "Done" });
    const runningCard = await seedCard(boardId, { repoId, status: "running", title: "Running" });

    const killCalls: string[] = [];
    await runPlugin({
      sessions: [`card-${doneCard.id}`],
      killSessionCalls: killCalls,
    });

    // doneCard's session should be killed (not running)
    expect(killCalls).toContain(`card-${doneCard.id}`);

    // runningCard has no session, should be marked failed
    const [updated] = await db.select().from(cards).where(eq(cards.id, runningCard.id));
    expect(updated.status).toBe("failed");
  });
});
