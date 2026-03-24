import { db } from "../db";
import { boards } from "../db/schema";

export default defineNitroPlugin(async () => {
  const existing = await db.select().from(boards).limit(1);
  if (existing.length === 0) {
    await db.insert(boards).values({ name: "Default" });
  }
});
