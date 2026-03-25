import { db } from "~~/server/db";
import { cards, workflowRuns } from "~~/server/db/schema";
import { eq } from "drizzle-orm";
import { tmuxManager } from "~~/server/services/tmux-manager";
import { eventBus } from "~~/server/utils/event-bus";
import { logger } from "~~/server/utils/logger";
import { getCardId, requireCard } from "~~/server/utils/params";
import { logCardEvent } from "~~/server/utils/card-events";

/**
 * Callback endpoint for Claude Code Stop hook.
 * Called when Claude finishes responding in an agent session.
 *
 * Moves card to review but keeps tmux session alive so user can
 * inspect the terminal output. Session + slot are released when
 * the card is archived (moved to done).
 *
 * POST /api/agents/:cardId/complete
 */
export default defineEventHandler(async (event) => {
  const cardId = getCardId(event);

  await logCardEvent(cardId, "stop_hook_received", "Claude Code Stop hook fired");
  logger.info(`Stop hook callback received for card ${cardId}`);

  const card = await requireCard(cardId);

  // Only process if card is actively running or queued (not already done/review)
  if (card.status === "review_ready" || card.status === "done") {
    await logCardEvent(cardId, "stop_hook_ignored", `card already ${card.status}`);
    return { ok: true, ignored: true };
  }

  // Update card to review — keep tmux session alive for inspection
  await db
    .update(cards)
    .set({
      column: "review",
      status: "review_ready",
      updatedAt: new Date(),
    })
    .where(eq(cards.id, cardId));

  // Update workflow run if exists
  await db
    .update(workflowRuns)
    .set({ status: "completed", endedAt: new Date() })
    .where(eq(workflowRuns.cardId, cardId));

  // Try to detect PR for the card's branch
  try {
    const run = await db.select().from(workflowRuns).where(eq(workflowRuns.cardId, cardId)).limit(1);
    if (run[0]?.branch) {
      const { execSync } = await import("node:child_process");
      const prJson = execSync(
        `gh pr list --head ${run[0].branch} --json number --limit 1`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();
      const prs = JSON.parse(prJson);
      if (prs.length > 0) {
        await db
          .update(cards)
          .set({ githubPrNumber: prs[0].number })
          .where(eq(cards.id, cardId));
      }
    }
  } catch {
    // PR detection is best-effort
  }

  // Stop live capture polling but keep session alive
  const sessionName = `card-${cardId}`;
  tmuxManager.stopCapture(sessionName);

  // Emit events
  eventBus.emit("card:moved", {
    cardId,
    fromColumn: "in_progress",
    toColumn: "review",
  });
  eventBus.emit("card:status-changed", { cardId, status: "review_ready" });
  eventBus.emit("workflow:completed", { cardId, status: "completed" });

  logger.info(`Card ${cardId} completed via Stop hook, moved to review (tmux session preserved)`);

  return { ok: true };
});
