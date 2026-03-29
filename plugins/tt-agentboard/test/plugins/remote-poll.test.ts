import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { pollRemoteSessions, checkRemoteSessionStatus } from "../../server/plugins/remote-poll";
import { CardService } from "../../server/domains/cards/card-service";
import { cards } from "../../server/shared/db/schema";
import type { RemotePollDeps } from "../../server/plugins/remote-poll";
import {
  db,
  cleanDb,
  seedBoard,
  seedRepo,
  seedCard,
  seedWorkflowRun,
  createTestEventBus,
  createNoopLogger,
  findEvents,
} from "../helpers/test-db";

describe("remote-poll", () => {
  describe("checkRemoteSessionStatus", () => {
    it("returns completed for finished sessions", () => {
      const exec = (() => JSON.stringify([{ id: "session_abc", status: "completed" }])) as never;
      expect(checkRemoteSessionStatus("session_abc", exec)).toBe("completed");
    });

    it("returns running for active sessions", () => {
      const exec = (() => JSON.stringify([{ id: "session_abc", status: "running" }])) as never;
      expect(checkRemoteSessionStatus("session_abc", exec)).toBe("running");
    });

    it("returns failed for errored sessions", () => {
      const exec = (() => JSON.stringify([{ id: "session_abc", status: "failed" }])) as never;
      expect(checkRemoteSessionStatus("session_abc", exec)).toBe("failed");
    });

    it("returns unknown when session not found", () => {
      const exec = (() => JSON.stringify([])) as never;
      expect(checkRemoteSessionStatus("session_abc", exec)).toBe("unknown");
    });

    it("returns unknown when execSync throws", () => {
      const exec = (() => {
        throw new Error("command failed");
      }) as never;
      expect(checkRemoteSessionStatus("session_abc", exec)).toBe("unknown");
    });
  });

  describe("pollRemoteSessions", () => {
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

    function createDeps(execSyncFn: (...args: unknown[]) => string): RemotePollDeps {
      return {
        db: db as never,
        logger: createNoopLogger(),
        cardService,
        eventBus: bus as never,
        execSync: execSyncFn as never,
        pollIntervalMs: 1000,
      };
    }

    it("does nothing when no running remote sessions", async () => {
      const deps = createDeps(() => "[]");
      await pollRemoteSessions(deps);
      // No errors, just returns early
    });

    it("marks completed sessions", async () => {
      const card = await seedCard(boardId, { repoId, status: "running" });
      await seedWorkflowRun(card.id, {
        remoteSessionId: "session_abc",
        status: "running",
      });

      const deps = createDeps(() => JSON.stringify([{ id: "session_abc", status: "completed" }]));

      await pollRemoteSessions(deps);

      const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
      expect(updated.status).toBe("review_ready");

      const completedEvents = findEvents(events, "workflow:completed");
      expect(completedEvents).toHaveLength(1);
    });

    it("marks failed sessions", async () => {
      const card = await seedCard(boardId, { repoId, status: "running" });
      await seedWorkflowRun(card.id, {
        remoteSessionId: "session_abc",
        status: "running",
      });

      const deps = createDeps(() => JSON.stringify([{ id: "session_abc", status: "failed" }]));

      await pollRemoteSessions(deps);

      const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
      expect(updated.status).toBe("failed");
    });

    it("skips sessions still running", async () => {
      const card = await seedCard(boardId, { repoId, status: "running" });
      await seedWorkflowRun(card.id, {
        remoteSessionId: "session_abc",
        status: "running",
      });

      const deps = createDeps(() => JSON.stringify([{ id: "session_abc", status: "running" }]));

      await pollRemoteSessions(deps);

      // Card should still be running
      const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
      expect(updated.status).toBe("running");
    });
  });
});
