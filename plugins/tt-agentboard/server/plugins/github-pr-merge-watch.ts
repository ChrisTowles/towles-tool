import { db } from "../shared/db";
import { cards, repositories, workspaceSlots } from "../shared/db/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import { getGitHubService, isGitHubConfigured } from "../domains/infra/github-service";
import { cardService } from "../domains/cards/card-service";
import { tmuxManager } from "../domains/infra/tmux-manager";
import { eventBus } from "../shared/event-bus";
import { logger } from "../utils/logger";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const POLL_INTERVAL_MS = Number(process.env.PR_MERGE_POLL_INTERVAL_MS) || 60_000;

/**
 * Polls cards in the "review" column that have a githubPrNumber.
 * When the PR is merged, automatically moves the card to "done"
 * and cleans up resources (tmux session, workspace slots).
 */
export default defineNitroPlugin(() => {
  if (!isGitHubConfigured()) {
    logger.info("gh CLI not authenticated — PR merge watch disabled");
    return;
  }

  const timer = setInterval(async () => {
    try {
      await checkMergedPrs();
    } catch (error) {
      logger.error("PR merge watch poll failed:", error);
    }
  }, POLL_INTERVAL_MS);

  // Also run once on startup (after a short delay to let DB initialize)
  setTimeout(() => checkMergedPrs().catch(() => {}), 5_000);

  logger.info(`PR merge watch plugin loaded (interval: ${POLL_INTERVAL_MS}ms)`);

  // Clean up on shutdown
  if (typeof globalThis.onBeforeExit === "function") {
    globalThis.onBeforeExit(() => clearInterval(timer));
  }
});

async function checkMergedPrs(): Promise<void> {
  // Find all cards in "review" column that have a PR number
  const reviewCards = await db
    .select({
      id: cards.id,
      githubPrNumber: cards.githubPrNumber,
      repoId: cards.repoId,
    })
    .from(cards)
    .where(
      and(
        eq(cards.column, "review"),
        isNotNull(cards.githubPrNumber),
        isNotNull(cards.repoId),
      ),
    );

  if (reviewCards.length === 0) return;

  const github = getGitHubService();

  for (const card of reviewCards) {
    if (!card.githubPrNumber || !card.repoId) continue;

    const repo = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, card.repoId))
      .get();

    if (!repo?.org) continue;

    try {
      const merged = await github.isPrMerged(repo.org, repo.name, card.githubPrNumber);
      if (!merged) continue;

      logger.info(
        `PR #${card.githubPrNumber} merged — moving card ${card.id} to done`,
      );

      // Clean up resources (same as move.post.ts done block)
      const sessionName = `card-${card.id}`;
      tmuxManager.stopCapture(sessionName);
      tmuxManager.killSession(sessionName);

      const claimedSlots = await db
        .select()
        .from(workspaceSlots)
        .where(eq(workspaceSlots.claimedByCardId, card.id));

      for (const slot of claimedSlots) {
        await db
          .update(workspaceSlots)
          .set({ status: "available", claimedByCardId: null })
          .where(eq(workspaceSlots.id, slot.id));

        const settingsPath = resolve(slot.path, ".claude", "settings.local.json");
        try {
          if (existsSync(settingsPath)) {
            unlinkSync(settingsPath);
          }
        } catch {
          // Non-fatal
        }

        eventBus.emit("slot:released", { slotId: slot.id });
      }

      await cardService.markDone(card.id);
      await cardService.logEvent(
        card.id,
        "pr_merged",
        `PR #${card.githubPrNumber} was merged — auto-moved to done`,
      );
    } catch (error) {
      logger.debug(
        `Failed to check PR #${card.githubPrNumber} for card ${card.id}: ${error}`,
      );
    }
  }
}
