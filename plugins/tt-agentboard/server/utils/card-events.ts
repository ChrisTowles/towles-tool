import { db } from "../db";
import { cardEvents } from "../db/schema";

export async function logCardEvent(cardId: number, event: string, detail?: string) {
  await db.insert(cardEvents).values({ cardId, event, detail });
}
