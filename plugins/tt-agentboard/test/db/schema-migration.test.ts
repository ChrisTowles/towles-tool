import { describe, it, expect } from "vitest";
import { db } from "../../server/db";
import { boards, cards, cardDependencies } from "../../server/db/schema";
import { eq } from "drizzle-orm";

describe("cardDependencies schema", () => {
  it("can insert and query card dependencies", async () => {
    // Create a board
    const [board] = await db.insert(boards).values({ name: "dep-test-board" }).returning();

    // Create two cards
    const [cardA] = await db
      .insert(cards)
      .values({ boardId: board.id, title: "Card A" })
      .returning();
    const [cardB] = await db
      .insert(cards)
      .values({ boardId: board.id, title: "Card B" })
      .returning();

    // Insert a dependency: B depends on A
    await db.insert(cardDependencies).values({
      cardId: cardB.id,
      dependsOnCardId: cardA.id,
    });

    // Query it back
    const deps = await db
      .select()
      .from(cardDependencies)
      .where(eq(cardDependencies.cardId, cardB.id));

    expect(deps).toHaveLength(1);
    expect(deps[0].dependsOnCardId).toBe(cardA.id);
  });

  it("cascade deletes dependencies when a card is deleted", async () => {
    // Create a board
    const [board] = await db.insert(boards).values({ name: "cascade-test-board" }).returning();

    // Create three cards: A, B, C
    const [cardA] = await db
      .insert(cards)
      .values({ boardId: board.id, title: "Card A" })
      .returning();
    const [cardB] = await db
      .insert(cards)
      .values({ boardId: board.id, title: "Card B" })
      .returning();
    const [cardC] = await db
      .insert(cards)
      .values({ boardId: board.id, title: "Card C" })
      .returning();

    // B depends on A, C depends on A
    await db.insert(cardDependencies).values([
      { cardId: cardB.id, dependsOnCardId: cardA.id },
      { cardId: cardC.id, dependsOnCardId: cardA.id },
    ]);

    // Verify deps exist
    const depsBefore = await db
      .select()
      .from(cardDependencies)
      .where(eq(cardDependencies.dependsOnCardId, cardA.id));
    expect(depsBefore).toHaveLength(2);

    // Delete card A — should cascade delete all deps referencing it
    await db.delete(cards).where(eq(cards.id, cardA.id));

    // Both dependency rows should be gone
    const depsAfterA = await db
      .select()
      .from(cardDependencies)
      .where(eq(cardDependencies.dependsOnCardId, cardA.id));
    expect(depsAfterA).toHaveLength(0);

    // Also test cascade on the cardId side: delete card B
    // First add a dep for B
    await db.insert(cardDependencies).values({
      cardId: cardB.id,
      dependsOnCardId: cardC.id,
    });

    const depsBeforeB = await db
      .select()
      .from(cardDependencies)
      .where(eq(cardDependencies.cardId, cardB.id));
    expect(depsBeforeB).toHaveLength(1);

    await db.delete(cards).where(eq(cards.id, cardB.id));

    const depsAfterB = await db
      .select()
      .from(cardDependencies)
      .where(eq(cardDependencies.cardId, cardB.id));
    expect(depsAfterB).toHaveLength(0);
  });
});
