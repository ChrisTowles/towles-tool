import type { H3Event } from "h3";
import { db } from "~~/server/db";
import { cards } from "~~/server/db/schema";
import { eq } from "drizzle-orm";

export function getCardId(event: H3Event): number {
  const cardId = Number(getRouterParam(event, "cardId"));
  if (!cardId || Number.isNaN(cardId)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid cardId" });
  }
  return cardId;
}

export async function requireCard(cardId: number) {
  const rows = await db.select().from(cards).where(eq(cards.id, cardId));
  if (rows.length === 0) {
    throw createError({ statusCode: 404, statusMessage: "Card not found" });
  }
  return rows[0]!;
}
