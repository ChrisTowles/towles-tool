import { db } from "../db";
import { cards, boards } from "../db/schema";
import { and, eq } from "drizzle-orm";
import { eventBus } from "../utils/event-bus";
import { logger } from "../utils/logger";

const POLL_INTERVAL_MS = Number(process.env.GITHUB_POLL_INTERVAL_MS) || 30_000;

export default defineNitroPlugin(async () => {
  if (!process.env.GITHUB_TOKEN) {
    logger.info("GITHUB_TOKEN not set — GitHub issue polling disabled");
    return;
  }

  // Listen for issue-found events and create cards automatically
  eventBus.on(
    "github:issue-found",
    async (data: { issueNumber: number; repoId: number; title: string; body: string | null }) => {
      try {
        const existing = await db
          .select()
          .from(cards)
          .where(and(eq(cards.repoId, data.repoId), eq(cards.githubIssueNumber, data.issueNumber)))
          .get();

        if (existing) return;

        const board = await db.select().from(boards).limit(1).get();
        if (!board) return;

        const [card] = await db
          .insert(cards)
          .values({
            boardId: board.id,
            title: data.title,
            description: data.body ?? "",
            repoId: data.repoId,
            column: "ready",
            position: 0,
            githubIssueNumber: data.issueNumber,
          })
          .returning();

        if (card) {
          logger.info(`Auto-created card #${card.id} from issue #${data.issueNumber}`);
          eventBus.emit("card:status-changed", { cardId: card.id, status: "idle" });
        }
      } catch (error) {
        logger.error(`Failed to create card from issue #${data.issueNumber}:`, error);
      }
    },
  );

  logger.info(
    `GitHub polling ready (interval: ${POLL_INTERVAL_MS}ms). Will start when repos are configured.`,
  );
});
