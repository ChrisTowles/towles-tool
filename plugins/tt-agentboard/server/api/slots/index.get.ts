import { db } from "~~/server/shared/db";
import { workspaceSlots } from "~~/server/shared/db/schema";

export default defineEventHandler(async () => {
  return db.select().from(workspaceSlots);
});
