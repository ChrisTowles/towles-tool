import { db } from "~~/server/db";
import { workspaceSlots } from "~~/server/db/schema";

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const result = await db
    .insert(workspaceSlots)
    .values({
      repoId: body.repoId,
      path: body.path,
      portConfig: body.portConfig ? JSON.stringify(body.portConfig) : null,
      envPath: body.envPath,
    })
    .returning();
  return result[0];
});
