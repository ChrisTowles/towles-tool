import { existsSync } from "node:fs";
import { join } from "node:path";
import { db } from "~~/server/shared/db";
import { workspaceSlots } from "~~/server/shared/db/schema";
import { inArray } from "drizzle-orm";

export default defineEventHandler(async () => {
  const slots = await db.select().from(workspaceSlots);

  // Prune slots whose paths no longer exist as git repos
  const staleIds = slots.filter((s) => !existsSync(join(s.path, ".git"))).map((s) => s.id);

  if (staleIds.length > 0) {
    await db.delete(workspaceSlots).where(inArray(workspaceSlots.id, staleIds));
    return slots.filter((s) => !staleIds.includes(s.id));
  }

  return slots;
});
