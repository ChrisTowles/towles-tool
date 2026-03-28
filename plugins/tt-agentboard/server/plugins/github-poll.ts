import { db } from "../shared/db";
import { cards, boards, repositories, workflowRuns, workspaceSlots } from "../shared/db/schema";
import { and, eq } from "drizzle-orm";
import { eventBus } from "../shared/event-bus";
import { isGitHubConfigured, getGitHubService } from "../domains/infra/github-service";
import { gitQuery } from "../domains/infra/git";
import { cardService } from "../domains/cards/card-service";
import { logger } from "../utils/logger";

const POLL_INTERVAL_MS = Number(process.env.GITHUB_POLL_INTERVAL_MS) || 30_000;

export default defineNitroPlugin(async () => {
  if (!isGitHubConfigured()) {
    logger.info("gh CLI not authenticated — GitHub issue polling disabled");
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

  // Check if branch commits are already in main
  const isBranchMerged = async (repoPath: string, branch: string, baseBranch: string): Promise<boolean> => {
    // Fetch base branch — if this fails, can't check anything
    const fetchBase = await gitQuery(repoPath, ["fetch", "origin", baseBranch]);
    if (fetchBase === null) return false;

    // Fetch the card branch — if gone from remote, check if it was ever merged
    const fetchBranch = await gitQuery(repoPath, ["fetch", "origin", branch]);
    if (fetchBranch === null) {
      // Branch deleted from remote — check if local tracking ref exists and is merged
      const localRef = await gitQuery(repoPath, ["rev-parse", `refs/remotes/origin/${branch}`]);
      if (localRef === null) return false; // never fetched, can't confirm
      // Fall through to ancestor check with stale local ref
    }

    // Check if branch tip is an ancestor of base
    const result = await gitQuery(repoPath, [
      "merge-base",
      "--is-ancestor",
      `origin/${branch}`,
      `origin/${baseBranch}`,
    ]);
    return result !== null;
  };

  const checkMergedBranches = async () => {
    try {
      const reviewCards = await db.select().from(cards).where(eq(cards.status, "review_ready"));
      if (reviewCards.length === 0) return;

      // Pre-fetch all repos and slots to avoid per-card queries
      const allRepos = await db.select().from(repositories);
      const repoMap = new Map(allRepos.map((r) => [r.id, r]));

      const allSlots = await db.select().from(workspaceSlots);
      const slotsByRepo = Map.groupBy(allSlots, (s) => s.repoId);

      // Cache valid slot path per repo
      const validSlotCache = new Map<number, string | null>();
      const getValidSlot = async (repoId: number): Promise<string | null> => {
        if (validSlotCache.has(repoId)) return validSlotCache.get(repoId)!;
        const slots = slotsByRepo.get(repoId) ?? [];
        for (const s of slots) {
          if (await gitQuery(s.path, ["rev-parse", "--git-dir"])) {
            validSlotCache.set(repoId, s.path);
            return s.path;
          }
        }
        validSlotCache.set(repoId, null);
        return null;
      };

      // Track which repo+baseBranch combos we've already fetched
      const fetched = new Set<string>();

      // Get all branches for review cards in one query
      const allRuns = await db
        .select({ cardId: workflowRuns.cardId, branch: workflowRuns.branch })
        .from(workflowRuns);
      const branchByCard = new Map(allRuns.map((r) => [r.cardId, r.branch]));

      const gh = getGitHubService();

      const markDone = async (cardId: number, reason: string) => {
        await db
          .update(cards)
          .set({ status: "done", column: "done", updatedAt: new Date() })
          .where(eq(cards.id, cardId));
        await cardService.logEvent(cardId, "auto_done", reason);
        eventBus.emit("card:status-changed", { cardId, status: "done" });
        logger.info(`Card #${cardId} moved to done — ${reason}`);
      };

      for (const card of reviewCards) {
        if (!card.repoId) continue;

        const branch = branchByCard.get(card.id);
        const repo = repoMap.get(card.repoId);
        let merged = false;

        // Try git-based branch merge check
        if (branch && branch !== "unknown") {
          const slotPath = await getValidSlot(card.repoId);
          if (slotPath) {
            const baseBranch = repo?.defaultBranch ?? "main";
            const fetchKey = `${slotPath}::${baseBranch}`;
            if (!fetched.has(fetchKey)) {
              await gitQuery(slotPath, ["fetch", "origin", baseBranch]);
              fetched.add(fetchKey);
            }
            if (await isBranchMerged(slotPath, branch, baseBranch)) {
              await markDone(card.id, `Branch ${branch} merged into ${baseBranch}`);
              merged = true;
            }
          }
        }

        // Fall back to GitHub issue closed check
        if (!merged && card.githubIssueNumber && repo?.org && repo?.name) {
          try {
            if (await gh.isIssueClosed(repo.org, repo.name, card.githubIssueNumber)) {
              await markDone(card.id, `Issue #${card.githubIssueNumber} closed`);
            }
          } catch (err) {
            logger.debug(`Failed to check issue #${card.githubIssueNumber} for card #${card.id}: ${err}`);
          }
        }
      }
    } catch (err) {
      logger.error("Failed to check merged branches:", err);
    }
  };

  // Run immediately then on interval
  checkMergedBranches();
  setInterval(checkMergedBranches, POLL_INTERVAL_MS);

  logger.info(
    `GitHub polling ready (interval: ${POLL_INTERVAL_MS}ms). Will start when repos are configured.`,
  );
});
