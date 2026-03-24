import { db } from "~~/server/db";
import { workspaceSlots } from "~~/server/db/schema";

export default defineEventHandler(async () => {
  return db.select().from(workspaceSlots);
});
