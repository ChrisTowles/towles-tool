import { describe, it, expect, beforeEach } from "vitest";
import { createCompletionSweep } from "../../server/plugins/completion-sweep";
import { db, cleanDb, seedBoard, seedRepo, seedCard, createNoopLogger } from "../helpers/test-db";

describe("completion-sweep", () => {
  let boardId: number;
  let repoId: number;
  let completedCardIds: number[];

  beforeEach(async () => {
    cleanDb();
    const board = await seedBoard();
    const repo = await seedRepo();
    boardId = board.id;
    repoId = repo.id;
    completedCardIds = [];
  });

  function createSweep(opts: { sessions: string[]; paneCommands: Record<string, string> }) {
    return createCompletionSweep({
      tmuxManager: {
        listSessions: () => opts.sessions,
        getPaneCommand: (name: string) => opts.paneCommands[name] ?? null,
      },
      db: db as never,
      logger: createNoopLogger() as never,
      triggerComplete: async (cardId: number) => {
        completedCardIds.push(cardId);
      },
    });
  }

  it("triggers complete for running card with idle tmux session", async () => {
    const card1 = await seedCard(boardId, { repoId, status: "running", title: "C1" });
    const card2 = await seedCard(boardId, { repoId, status: "running", title: "C2" });

    const { sweep } = createSweep({
      sessions: [`card-${card1.id}`, `card-${card2.id}`],
      paneCommands: {
        [`card-${card1.id}`]: "zsh",
        [`card-${card2.id}`]: "node",
      },
    });

    await sweep();

    // Only card1 (zsh = idle) should be triggered, card2 (node = agent running) should not
    expect(completedCardIds).toEqual([card1.id]);
  });

  it("does nothing when no tmux sessions exist", async () => {
    const { sweep } = createSweep({ sessions: [], paneCommands: {} });

    await sweep();

    expect(completedCardIds).toHaveLength(0);
  });

  it("skips sessions for cards not in running status", async () => {
    const card = await seedCard(boardId, { repoId, status: "done", title: "Done" });

    const { sweep } = createSweep({
      sessions: [`card-${card.id}`],
      paneCommands: { [`card-${card.id}`]: "zsh" },
    });

    await sweep();

    expect(completedCardIds).toHaveLength(0);
  });

  it("skips sessions where agent is still running", async () => {
    const card = await seedCard(boardId, { repoId, status: "running", title: "C1" });

    const { sweep } = createSweep({
      sessions: [`card-${card.id}`],
      paneCommands: { [`card-${card.id}`]: "node" },
    });

    await sweep();

    expect(completedCardIds).toHaveLength(0);
  });

  it("handles triggerComplete failure gracefully", async () => {
    const card = await seedCard(boardId, { repoId, status: "running", title: "C1" });

    const { sweep } = createCompletionSweep({
      tmuxManager: {
        listSessions: () => [`card-${card.id}`],
        getPaneCommand: () => "zsh",
      },
      db: db as never,
      logger: createNoopLogger() as never,
      triggerComplete: async () => {
        throw new Error("server down");
      },
    });

    // Should not throw
    await expect(sweep()).resolves.not.toThrow();
  });

  it("skips non-card sessions", async () => {
    const card = await seedCard(boardId, { repoId, status: "running", title: "C1" });

    const { sweep } = createSweep({
      sessions: [`card-${card.id}`, "my-session"],
      paneCommands: {
        [`card-${card.id}`]: "zsh",
        "my-session": "zsh",
      },
    });

    await sweep();

    expect(completedCardIds).toEqual([card.id]);
  });
});
