import { db } from "~~/server/db";
import { cards } from "~~/server/db/schema";

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const result = await db
    .insert(cards)
    .values({
      boardId: body.boardId || 1,
      title: body.title,
      description: body.description,
      repoId: body.repoId,
      column: body.column || "backlog",
      position: body.position || 0,
      executionMode: body.executionMode || "headless",
      branchMode: body.branchMode || "create",
      workflowId: body.workflowId,
    })
    .returning();
  return result[0];
});
