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
import type { TestBus, TestEvents } from "../helpers/test-db";

describe("remote-poll", () => {
  describe("checkRemoteSessionStatus", () => {
    it("returns completed for finished sessions", async () => {
      const exec = (async () => ({ stdout: JSON.stringify([{ id: "session_abc", status: "completed" }]), exitCode: 0 })) as never;
      expect(await checkRemoteSessionStatus("session_abc", exec)).toBe("completed");
    });

    it("returns running for active sessions", async () => {
      const exec = (async () => ({ stdout: JSON.stringify([{ id: "session_abc", status: "running" }]), exitCode: 0 })) as never;
      expect(await checkRemoteSessionStatus("session_abc", exec)).toBe("running");
    });

    it("returns failed for errored sessions", async () => {
      const exec = (async () => ({ stdout: JSON.stringify([{ id: "session_abc", status: "failed" }]), exitCode: 0 })) as never;
      expect(await checkRemoteSessionStatus("session_abc", exec)).toBe("failed");
    });

    it("returns unknown when session not found", async () => {
      const exec = (async () => ({ stdout: JSON.stringify([]), exitCode: 0 })) as never;
      expect(await checkRemoteSessionStatus("session_abc", exec)).toBe("unknown");
    });

    it("returns unknown when exec throws", async () => {
      const exec = (async () => {
        throw new Error("command failed");
      }) as never;
      expect(await checkRemoteSessionStatus("session_abc", exec)).toBe("unknown");
    });
  });

  describe("pollRemoteSessions", () => {
    let bus: TestBus;
    let events: TestEvents;
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

    function createDeps(execFn: (...args: unknown[]) => Promise<{ stdout: string; exitCode: number }>): RemotePollDeps {
      return {
        db: db as never,
        logger: createNoopLogger(),
        cardService,
        eventBus: bus as never,
        exec: execFn as never,
        pollIntervalMs: 1000,
      };
    }

    it("does nothing when no running remote sessions", async () => {
      const deps = createDeps(async () => ({ stdout: "[]", exitCode: 0 }));
      await pollRemoteSessions(deps);
      // No errors, just returns early
    });

    it("marks completed sessions", async () => {
      const card = await seedCard(boardId, { repoId, status: "running" });
      await seedWorkflowRun(card.id, {
        remoteSessionId: "session_abc",
        status: "running",
      });

      const deps = createDeps(async () => ({ stdout: JSON.stringify([{ id: "session_abc", status: "completed" }]), exitCode: 0 }));

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

      const deps = createDeps(async () => ({ stdout: JSON.stringify([{ id: "session_abc", status: "failed" }]), exitCode: 0 }));

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

      const deps = createDeps(async () => ({ stdout: JSON.stringify([{ id: "session_abc", status: "running" }]), exitCode: 0 }));

      await pollRemoteSessions(deps);

      // Card should still be running
      const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
      expect(updated.status).toBe("running");
    });
  });
});
