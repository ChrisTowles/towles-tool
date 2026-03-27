import { db } from "~~/server/shared/db";
import { workspaceSlots } from "~~/server/shared/db/schema";
import { eq } from "drizzle-orm";

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"));
  const body = await readBody(event);
  const updates: Record<string, unknown> = {};
  if (body.path !== undefined) updates.path = body.path;
  if (body.portConfig !== undefined) updates.portConfig = JSON.stringify(body.portConfig);
  if (body.envPath !== undefined) updates.envPath = body.envPath;
  if (body.status !== undefined) updates.status = body.status;

  const result = await db
    .update(workspaceSlots)
    .set(updates)
    .where(eq(workspaceSlots.id, id))
    .returning();
  if (result.length === 0) {
    throw createError({ statusCode: 404, statusMessage: "Slot not found" });
  }
  return result[0];
});
