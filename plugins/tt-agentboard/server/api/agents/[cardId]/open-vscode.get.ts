import { db } from "~~/server/db";
import { workspaceSlots } from "~~/server/db/schema";
import { eq } from "drizzle-orm";
import { execSync } from "node:child_process";
import { logger } from "~~/server/utils/logger";

/**
 * GET /api/agents/:cardId/open-vscode
 * Opens the card's workspace slot directory in VS Code.
 */
export default defineEventHandler(async (event) => {
  const cardId = Number(getRouterParam(event, "cardId"));

  if (!cardId || Number.isNaN(cardId)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid cardId" });
  }

  const slots = await db
    .select()
    .from(workspaceSlots)
    .where(eq(workspaceSlots.claimedByCardId, cardId));

  if (slots.length === 0) {
    throw createError({ statusCode: 404, statusMessage: "No workspace slot found for this card" });
  }

  const slotPath = slots[0]!.path;

  try {
    execSync(`code ${JSON.stringify(slotPath)}`, { stdio: "ignore" });
    logger.info(`Opened VS Code for card ${cardId} at ${slotPath}`);
    return { ok: true, path: slotPath };
  } catch (err) {
    logger.error(`Failed to open VS Code for card ${cardId}:`, err);
    throw createError({ statusCode: 500, statusMessage: "Failed to open VS Code" });
  }
});
