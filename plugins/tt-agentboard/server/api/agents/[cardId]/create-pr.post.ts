import { db } from "~~/server/db";
import { cards, workflowRuns, workspaceSlots, repositories } from "~~/server/db/schema";
import { eq } from "drizzle-orm";
import { execSync } from "node:child_process";
import { getCardId, requireCard } from "~~/server/utils/params";
import { logCardEvent } from "~~/server/utils/card-events";
import { logger } from "~~/server/utils/logger";

/**
 * Create a PR for a card's branch.
 * Pushes the branch and creates a PR via gh CLI.
 *
 * POST /api/agents/:cardId/create-pr
 */
export default defineEventHandler(async (event) => {
  const cardId = getCardId(event);
  const card = await requireCard(cardId);

  // Get the branch from workflow runs
  const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.cardId, cardId)).limit(1);

  const branch = runs[0]?.branch;
  if (!branch) {
    throw createError({ statusCode: 400, statusMessage: "No branch found for this card" });
  }

  // Get the slot path for running git commands
  const slots = await db
    .select()
    .from(workspaceSlots)
    .where(eq(workspaceSlots.claimedByCardId, cardId))
    .limit(1);

  // If no claimed slot, find one from the card's repo
  let cwd: string;
  if (slots[0]) {
    cwd = slots[0].path;
  } else if (card.repoId) {
    const repoSlots = await db
      .select()
      .from(workspaceSlots)
      .where(eq(workspaceSlots.repoId, card.repoId))
      .limit(1);
    if (!repoSlots[0]) {
      throw createError({
        statusCode: 400,
        statusMessage: "No workspace slot found for this repo",
      });
    }
    cwd = repoSlots[0].path;
  } else {
    throw createError({ statusCode: 400, statusMessage: "Card has no repo" });
  }

  // Get the repo's default branch
  let base = "main";
  if (card.repoId) {
    const repos = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, card.repoId))
      .limit(1);
    if (repos[0]?.defaultBranch) {
      base = repos[0].defaultBranch;
    }
  }

  try {
    // Ensure we're on the correct branch before pushing
    execSync(`git checkout ${branch}`, { cwd, stdio: "ignore", timeout: 10000 });

    // Push the branch
    execSync(`git push -u origin ${branch}`, { cwd, stdio: "ignore", timeout: 30000 });

    // Create PR — gh pr create returns the PR URL on stdout
    const prTitle = card.title;
    const prBody = card.description ?? "";
    const prUrl = execSync(
      `gh pr create --title "${prTitle.replace(/"/g, '\\"')}" --body "${prBody.replace(/"/g, '\\"')}" --base ${base} --head ${branch}`,
      { cwd, encoding: "utf-8", timeout: 30000 },
    ).trim();

    // Extract PR number from URL (e.g., https://github.com/.../pull/42)
    const prNumMatch = prUrl.match(/\/pull\/(\d+)/);
    const pr = {
      number: prNumMatch ? Number(prNumMatch[1]) : 0,
      url: prUrl,
    };

    // Update card with PR number
    await db
      .update(cards)
      .set({ githubPrNumber: pr.number, updatedAt: new Date() })
      .where(eq(cards.id, cardId));

    await logCardEvent(cardId, "pr_created", `PR #${pr.number}: ${pr.url}`);
    logger.info(`PR #${pr.number} created for card ${cardId}: ${pr.url}`);

    return { prNumber: pr.number, prUrl: pr.url };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logCardEvent(cardId, "pr_failed", msg);
    throw createError({ statusCode: 500, statusMessage: `Failed to create PR: ${msg}` });
  }
});
