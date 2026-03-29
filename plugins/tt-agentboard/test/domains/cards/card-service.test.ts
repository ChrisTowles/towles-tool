import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { CardService } from "../../../server/domains/cards/card-service";
import { cards, cardEvents } from "../../../server/shared/db/schema";
import {
  db,
  cleanDb,
  seedBoard,
  seedRepo,
  seedCard,
  seedDependency,
  createTestEventBus,
  createNoopLogger,
  findEvents,
} from "../../helpers/test-db";

describe("CardService", () => {
  let service: CardService;
  let bus: ReturnType<typeof createTestEventBus>["bus"];
  let events: ReturnType<typeof createTestEventBus>["events"];
  let boardId: number;
  let repoId: number;

  beforeEach(async () => {
    cleanDb();
    const board = await seedBoard();
    const repo = await seedRepo();
    boardId = board.id;
    repoId = repo.id;

    ({ bus, events } = createTestEventBus());
    service = new CardService({
      db,
      eventBus: bus,
      logger: createNoopLogger() as never,
    });
  });

  describe("updateStatus()", () => {
    it("updates DB and emits card:status-changed", async () => {
      const card = await seedCard(boardId, { repoId });

      await service.updateStatus(card.id, "running");

      const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
      expect(updated.status).toBe("running");

      const statusEvents = findEvents(events, "card:status-changed");
      expect(statusEvents).toHaveLength(1);
      expect(statusEvents[0].data).toEqual({ cardId: card.id, status: "running" });
    });
  });

  describe("moveToColumn()", () => {
    it("fetches card, updates DB column, emits card:moved with fromColumn", async () => {
      const card = await seedCard(boardId, { repoId, column: "ready" });

      await service.moveToColumn(card.id, "in_progress");

      const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
      expect(updated.column).toBe("in_progress");

      const movedEvents = findEvents(events, "card:moved");
      expect(movedEvents).toHaveLength(1);
      expect(movedEvents[0].data).toEqual({
        cardId: card.id,
        fromColumn: "ready",
        toColumn: "in_progress",
      });
    });

    it("throws if card not found", async () => {
      await expect(service.moveToColumn(999, "done")).rejects.toThrow("Card 999 not found");
    });
  });

  describe("markFailed()", () => {
    it("calls updateStatus(failed) and logEvent with reason", async () => {
      const card = await seedCard(boardId, { repoId });

      await service.markFailed(card.id, "tmux crashed");

      const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
      expect(updated.status).toBe("failed");

      const statusEvents = findEvents(events, "card:status-changed");
      expect(statusEvents).toHaveLength(1);
      expect(statusEvents[0].data).toEqual({ cardId: card.id, status: "failed" });

      const logRows = await db.select().from(cardEvents).where(eq(cardEvents.cardId, card.id));
      expect(logRows).toHaveLength(1);
      expect(logRows[0].event).toBe("failed");
      expect(logRows[0].detail).toBe("tmux crashed");
    });

    it("calls updateStatus(failed) without logEvent when no reason", async () => {
      const card = await seedCard(boardId, { repoId });

      await service.markFailed(card.id);

      const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
      expect(updated.status).toBe("failed");

      const logRows = await db.select().from(cardEvents).where(eq(cardEvents.cardId, card.id));
      expect(logRows).toHaveLength(0);
    });
  });

  describe("markComplete()", () => {
    it("sets status=review_ready + column=review, emits actual fromColumn", async () => {
      const card = await seedCard(boardId, { repoId, column: "in_progress" });

      await service.markComplete(card.id);

      const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
      expect(updated.status).toBe("review_ready");
      expect(updated.column).toBe("review");

      const statusEvents = findEvents(events, "card:status-changed");
      expect(statusEvents).toHaveLength(1);
      expect(statusEvents[0].data).toEqual({ cardId: card.id, status: "review_ready" });

      const movedEvents = findEvents(events, "card:moved");
      expect(movedEvents).toHaveLength(1);
      expect(movedEvents[0].data).toEqual({
        cardId: card.id,
        fromColumn: "in_progress",
        toColumn: "review",
      });
    });

    it("emits simplify_review as fromColumn when card was in that column", async () => {
      const card = await seedCard(boardId, { repoId, column: "simplify_review" });

      await service.markComplete(card.id);

      const movedEvents = findEvents(events, "card:moved");
      expect(movedEvents).toHaveLength(1);
      expect(movedEvents[0].data).toEqual({
        cardId: card.id,
        fromColumn: "simplify_review",
        toColumn: "review",
      });
    });
  });

  describe("logEvent()", () => {
    it("inserts into cardEvents table", async () => {
      const card = await seedCard(boardId, { repoId });

      await service.logEvent(card.id, "execution_start", "some detail");

      const logRows = await db.select().from(cardEvents).where(eq(cardEvents.cardId, card.id));
      expect(logRows).toHaveLength(1);
      expect(logRows[0].event).toBe("execution_start");
      expect(logRows[0].detail).toBe("some detail");
    });
  });

  describe("resolveDependencies()", () => {
    it("returns empty when no cards depend on completed card", async () => {
      const card = await seedCard(boardId, { repoId, status: "done" });

      const result = await service.resolveDependencies(card.id);
      expect(result).toEqual([]);
    });

    it("unblocks cards when all deps are done", async () => {
      const cardA = await seedCard(boardId, { repoId, status: "done", title: "A" });
      const cardB = await seedCard(boardId, { repoId, status: "done", title: "B" });
      const cardC = await seedCard(boardId, {
        repoId,
        status: "blocked",
        column: "ready",
        title: "C",
      });

      await seedDependency(cardC.id, cardA.id);
      await seedDependency(cardC.id, cardB.id);

      const result = await service.resolveDependencies(cardA.id);
      expect(result).toEqual([cardC.id]);

      const [updated] = await db.select().from(cards).where(eq(cards.id, cardC.id));
      expect(updated.status).toBe("idle");
      expect(updated.column).toBe("ready");
    });

    it("does NOT unblock when some deps still pending", async () => {
      const cardA = await seedCard(boardId, { repoId, status: "done", title: "A" });
      const cardB = await seedCard(boardId, { repoId, status: "running", title: "B" });
      const cardC = await seedCard(boardId, {
        repoId,
        status: "blocked",
        column: "ready",
        title: "C",
      });

      await seedDependency(cardC.id, cardA.id);
      await seedDependency(cardC.id, cardB.id);

      const result = await service.resolveDependencies(cardA.id);
      expect(result).toEqual([]);

      const [updated] = await db.select().from(cards).where(eq(cards.id, cardC.id));
      expect(updated.status).toBe("blocked");
    });
  });
});
