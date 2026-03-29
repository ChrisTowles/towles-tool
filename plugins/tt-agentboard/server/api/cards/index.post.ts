import { db } from "~~/server/shared/db";
import { cards } from "~~/server/shared/db/schema";
import { cardService } from "~~/server/domains/cards/card-service";

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const result = await db
    .insert(cards)
    .values({
      boardId: body.boardId || 1,
      title: body.title,
      description: body.description,
      repoId: body.repoId,
      column: body.column || "ready",
      position: body.position || 0,
      executionMode: body.executionMode || "auto-claude",
      branchMode: body.branchMode || "create",
      workflowId: body.workflowId,
    })
    .returning();
  const card = result[0]!;
  await cardService.logEvent(
    card.id,
    "card_created",
    `column=${card.column}, mode=${card.executionMode}`,
  );
  return card;
});
