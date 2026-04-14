import { rmSync } from "node:fs";
import { join } from "node:path";

import { getConfig } from "./config.js";
import { ARTIFACTS } from "./prompt-templates/index.js";
import type { StepName } from "./prompt-templates/index.js";
import { createPr } from "./steps/create-pr.js";
import { stepImplement } from "./steps/implement.js";
import { stepPlan, stepReview, stepSimplify } from "./steps/simple-steps.js";
import { LABELS, ensureLabelsExist, removeLabel, setLabel } from "./labels.js";
import type { ExecSafeFn } from "./labels.js";
import { logger } from "./logger.js";

import { ensureDir, execSafe, fileExists, ghRaw, git, readFile, writeFile } from "@towles/shared";
import type { IssueContext } from "./utils.js";
import type { SpawnClaudeFn } from "./spawn-claude.js";

export { type StepName, STEP_NAMES } from "./prompt-templates/index.js";

export interface PipelineDeps {
  spawnFn?: SpawnClaudeFn;
  exec?: ExecSafeFn;
}

export async function runPipeline(
  ctx: IssueContext,
  untilStep?: StepName,
  deps?: PipelineDeps,
): Promise<void> {
  const cfg = getConfig();
  const exec = deps?.exec;
  const spawnFn = deps?.spawnFn;
  logger.info(`Pipeline starting for ${ctx.repo}#${ctx.number}: ${ctx.title}`);

  ensureDir(ctx.issueDir);
  const ramblingsPath = join(ctx.issueDir, ARTIFACTS.initialRamblings);
  if (!fileExists(ramblingsPath)) {
    const content = `# ${ctx.title}\n\n> ${ctx.repo}#${ctx.number}\n\n${ctx.body ?? ""}`;
    writeFile(ramblingsPath, content);
    logger.info("Saved initial-ramblings.md");
  }

  // Label management
  await ensureLabelsExist(ctx.repo, exec);
  await removeLabel(ctx.repo, ctx.number, cfg.triggerLabel, exec);
  await setLabel(ctx.repo, ctx.number, LABELS.inProgress, exec);

  try {
    // Step 1: Plan (runs once)
    if (!(await stepPlan(ctx, spawnFn))) {
      await handleFailure(ctx, "plan", undefined, exec);
      return;
    }
    if (untilStep === "plan") {
      logger.info(`Pipeline paused after "plan" (--until plan)`);
      return;
    }

    // Steps 2-4: Implement → Simplify → Review loop
    const maxRetries = cfg.maxReviewRetries;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Clear previous iteration artifacts (except plan)
      if (attempt > 0) {
        clearArtifact(ctx, ARTIFACTS.completedSummary);
        clearArtifact(ctx, ARTIFACTS.simplifySummary);
        clearArtifact(ctx, ARTIFACTS.review);
      }

      // Implement
      if (!(await stepImplement(ctx, spawnFn))) {
        await handleFailure(ctx, "implement", undefined, exec);
        return;
      }
      if (untilStep === "implement") {
        logger.info(`Pipeline paused after "implement" (--until implement)`);
        return;
      }

      // Simplify
      if (!(await stepSimplify(ctx, spawnFn))) {
        await handleFailure(ctx, "simplify", undefined, exec);
        return;
      }
      if (untilStep === "simplify") {
        logger.info(`Pipeline paused after "simplify" (--until simplify)`);
        return;
      }

      // Review
      if (!(await stepReview(ctx, spawnFn))) {
        await handleFailure(ctx, "review", undefined, exec);
        return;
      }
      if (untilStep === "review") {
        logger.info(`Pipeline paused after "review" (--until review)`);
        return;
      }

      // Check review result
      if (isReviewPass(ctx)) {
        const prUrl = await createPr(ctx, exec);
        await removeLabel(ctx.repo, ctx.number, LABELS.inProgress, exec);
        await setLabel(ctx.repo, ctx.number, LABELS.success, exec);
        await setLabel(ctx.repo, ctx.number, LABELS.review, exec);
        logger.info(`Pipeline complete for ${ctx.repo}#${ctx.number} — ${prUrl}`);
        return;
      }

      // Review failed
      if (attempt < maxRetries) {
        logger.warn(
          `Review did not pass (attempt ${attempt + 1}/${maxRetries + 1}), retrying implement→simplify→review…`,
        );
      }
    }

    // All retries exhausted
    await handleFailure(
      ctx,
      "review",
      `auto-claude: review did not pass after ${maxRetries + 1} attempts. Labelled \`${LABELS.failed}\`.`,
      exec,
    );
  } finally {
    await checkoutMain();
  }
}

function clearArtifact(ctx: IssueContext, artifact: string): void {
  rmSync(join(ctx.issueDir, artifact), { force: true });
}

function isReviewPass(ctx: IssueContext): boolean {
  const reviewPath = join(ctx.issueDir, ARTIFACTS.review);
  if (!fileExists(reviewPath)) return false;
  const content = readFile(reviewPath);
  const firstLine = content.split("\n")[0].trim().toUpperCase();
  return firstLine === "PASS";
}

async function handleFailure(
  ctx: IssueContext,
  stepName: StepName,
  comment?: string,
  exec?: ExecSafeFn,
): Promise<void> {
  await removeLabel(ctx.repo, ctx.number, LABELS.inProgress, exec);
  await setLabel(ctx.repo, ctx.number, LABELS.failed, exec);
  if (comment) {
    await ghRaw(
      ["issue", "comment", String(ctx.number), "--repo", ctx.repo, "--body", comment],
      exec,
    );
  }
  logger.info(`Pipeline stopped at "${stepName}" for ${ctx.repo}#${ctx.number}`);
}

async function checkoutMain(): Promise<void> {
  await git(["checkout", getConfig().mainBranch]).catch(() => {
    // Best-effort checkout — may fail if branch doesn't exist locally yet
  });

  const stashList = await execSafe("git", ["stash", "list"]);
  if (stashList.ok) {
    const lines = stashList.stdout.split("\n");
    const idx = lines.findIndex((l) => l.includes("auto-claude: before switching to"));
    if (idx >= 0) {
      await execSafe("git", ["stash", "pop", `stash@{${idx}}`]);
      logger.info("Restored stashed changes");
    }
  }
}
