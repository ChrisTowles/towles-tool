import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createQueueManager } from "../../server/plugins/queue-manager";
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
} from "../helpers/test-db";
import type { TestBus } from "../helpers/test-db";

describe("Queue Manager Plugin", () => {
  let bus: TestBus;
  let boardId: number;
  let repoId: number;
  let executedCardIds: number[];

  beforeEach(async () => {
    cleanDb();
    const board = await seedBoard();
    const repo = await seedRepo();
    boardId = board.id;
    repoId = repo.id;
    executedCardIds = [];

    ({ bus } = createTestEventBus());

    const cardService = new CardService({
      db,
      eventBus: bus,
      logger: createNoopLogger() as never,
    });

    createQueueManager({
      db: db as never,
      eventBus: bus as never,
      logger: createNoopLogger() as never,
      agentExecutor: {
        startExecution: async (cardId: number) => {
          executedCardIds.push(cardId);
        },
      },
      cardService,
    });
  });

  it("starts next queued card when slot released", async () => {
    const slot = await seedSlot(repoId, { path: "/ws/slot-1", status: "available" });
    const card = await seedCard(boardId, {
      repoId,
      column: "in_progress",
      status: "queued",
    });

    bus.emit("slot:released", { slotId: slot.id });
    await new Promise((r) => setTimeout(r, 50));

    expect(executedCardIds).toContain(card.id);

    // Card should have been moved to in_progress
    const [updated] = await db.select().from(cards).where(eq(cards.id, card.id));
    expect(updated.column).toBe("in_progress");
  });

  it("skips when slot not found", async () => {
    bus.emit("slot:released", { slotId: 999 });

    await new Promise((r) => setTimeout(r, 50));

    expect(executedCardIds).toHaveLength(0);
  });

  it("skips when MAX_CONCURRENT reached", async () => {
    const slot = await seedSlot(repoId, { path: "/ws/slot-1", status: "available" });
    // Create 3 running cards (default max concurrent)
    await seedCard(boardId, { repoId, status: "running", title: "R1" });
    await seedCard(boardId, { repoId, status: "running", title: "R2" });
    await seedCard(boardId, { repoId, status: "running", title: "R3" });
    await seedCard(boardId, { repoId, status: "queued", column: "in_progress", title: "Q1" });

    bus.emit("slot:released", { slotId: slot.id });

    await new Promise((r) => setTimeout(r, 50));

    expect(executedCardIds).toHaveLength(0);
  });

  it("does nothing when no queued cards for repo", async () => {
    const slot = await seedSlot(repoId, { path: "/ws/slot-1", status: "available" });

    bus.emit("slot:released", { slotId: slot.id });

    await new Promise((r) => setTimeout(r, 50));

    expect(executedCardIds).toHaveLength(0);
  });
});
