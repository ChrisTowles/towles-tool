import { db } from "~~/server/db";
import { cards } from "~~/server/db/schema";
import { eq } from "drizzle-orm";

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const boardId = Number(query.boardId) || 1;
  return db.select().from(cards).where(eq(cards.boardId, boardId)).orderBy(cards.position);
});
