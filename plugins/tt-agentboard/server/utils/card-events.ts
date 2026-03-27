import { db } from "../shared/db";
import { cardEvents } from "../shared/db/schema";

export async function logCardEvent(cardId: number, event: string, detail?: string) {
  await db.insert(cardEvents).values({ cardId, event, detail });
}
