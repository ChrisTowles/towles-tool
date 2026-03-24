import { db } from "../db";
import { cards, repositories } from "../db/schema";
import { eq } from "drizzle-orm";
import { eventBus } from "../utils/event-bus";
import { getGitHubService } from "../services/github-service";
import { workflowLoader } from "../services/workflow-loader";
import { logger } from "../utils/logger";

type CardStatus = string;

/** Map card status to which workflow label key to apply */
const STATUS_TO_LABEL_KEY: Record<
  string,
  keyof NonNullable<{ in_progress?: string; success?: string; failure?: string }>
> = {
  running: "in_progress",
  queued: "in_progress",
  done: "success",
  review_ready: "success",
  failed: "failure",
};

/** All label keys so we can remove stale ones */
const ALL_LABEL_KEYS = ["in_progress", "success", "failure"] as const;

export default defineNitroPlugin(() => {
  if (!process.env.GITHUB_TOKEN) {
    logger.info("GITHUB_TOKEN not set — GitHub label sync disabled");
    return;
  }

  eventBus.on("card:status-changed", async (data: { cardId: number; status: CardStatus }) => {
    const labelKey = STATUS_TO_LABEL_KEY[data.status];
    if (!labelKey) return;

    try {
      // Fetch card with repo info
      const card = await db.select().from(cards).where(eq(cards.id, data.cardId)).get();
      if (!card?.githubIssueNumber || !card.repoId || !card.workflowId) return;

      const repo = await db
        .select()
        .from(repositories)
        .where(eq(repositories.id, card.repoId))
        .get();
      if (!repo?.org) return;

      // Get workflow labels config
      const workflow = workflowLoader.get(card.workflowId);
      const labels = workflow?.labels;
      if (!labels) return;

      const addLabel = labels[labelKey];
      if (!addLabel) return;

      // Remove all other workflow labels, add the current one
      const removeLabels = ALL_LABEL_KEYS.filter((k) => k !== labelKey)
        .map((k) => labels[k])
        .filter((l): l is string => !!l);

      const github = getGitHubService();
      await github.transitionLabels({
        owner: repo.org,
        repo: repo.name,
        issueNumber: card.githubIssueNumber,
        remove: removeLabels,
        add: [addLabel],
      });

      logger.info(
        `Synced label "${addLabel}" to issue #${card.githubIssueNumber} for card ${data.cardId}`,
      );
    } catch (error) {
      logger.error(`GitHub label sync failed for card ${data.cardId}:`, error);
    }
  });

  logger.info("GitHub label sync plugin loaded");
});
