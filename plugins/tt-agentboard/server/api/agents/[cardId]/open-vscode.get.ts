import { db } from "~~/server/db";
import { workspaceSlots, workflowRuns } from "~~/server/db/schema";
import { eq, desc } from "drizzle-orm";
import { execSync } from "node:child_process";
import { logger } from "~~/server/utils/logger";
import { getCardId } from "~~/server/utils/params";

/**
 * GET /api/agents/:cardId/open-vscode
 * Opens the card's workspace slot directory in VS Code.
 * Checks currently claimed slot first, then falls back to the last workflow run's slot.
 */
export default defineEventHandler(async (event) => {
  const cardId = getCardId(event);

  // Try currently claimed slot
  const claimed = await db
    .select()
    .from(workspaceSlots)
    .where(eq(workspaceSlots.claimedByCardId, cardId))
    .limit(1);

  let slotPath = claimed[0]?.path ?? null;

  // Fallback: look up slot from the most recent workflow run
  if (!slotPath) {
    const runs = await db
      .select({ slotId: workflowRuns.slotId })
      .from(workflowRuns)
      .where(eq(workflowRuns.cardId, cardId))
      .orderBy(desc(workflowRuns.id))
      .limit(1);

    if (runs[0]?.slotId) {
      const slot = await db
        .select()
        .from(workspaceSlots)
        .where(eq(workspaceSlots.id, runs[0].slotId))
        .limit(1);
      slotPath = slot[0]?.path ?? null;
    }
  }

  if (!slotPath) {
    throw createError({ statusCode: 404, statusMessage: "No workspace slot found for this card" });
  }

  try {
    execSync(`code ${JSON.stringify(slotPath)}`, { stdio: "ignore" });
    logger.info(`Opened VS Code for card ${cardId} at ${slotPath}`);
    return { ok: true, path: slotPath };
  } catch (err) {
    logger.error(`Failed to open VS Code for card ${cardId}:`, err);
    throw createError({ statusCode: 500, statusMessage: "Failed to open VS Code" });
  }
});
