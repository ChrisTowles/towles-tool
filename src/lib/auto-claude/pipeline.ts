import { rmSync } from "node:fs";
import { join } from "node:path";

import { getConfig } from "./config.js";
import { ARTIFACTS } from "./prompt-templates/index.js";
import type { StepName } from "./prompt-templates/index.js";
import { createPr } from "./steps/create-pr.js";
import { stepImplement } from "./steps/implement.js";
import { stepPlan } from "./steps/plan.js";
import { stepReview } from "./steps/review.js";
import { stepSimplify } from "./steps/simplify.js";
import {
  ensureDir,
  ensureLabelsExist,
  execSafe,
  fileExists,
  ghRaw,
  git,
  log,
  readFile,
  removeLabel,
  setLabel,
  writeFile,
} from "./utils.js";
import type { IssueContext } from "./utils.js";

export { type StepName, STEP_NAMES } from "./prompt-templates/index.js";

const STEP_RUNNERS: Record<StepName, (ctx: IssueContext) => Promise<boolean>> = {
  plan: stepPlan,
  implement: stepImplement,
  simplify: stepSimplify,
  review: stepReview,
};

export async function runPipeline(ctx: IssueContext, untilStep?: StepName): Promise<void> {
  const cfg = getConfig();
  log(`Pipeline starting for ${ctx.repo}#${ctx.number}: ${ctx.title}`);

  ensureDir(ctx.issueDir);
  const ramblingsPath = join(ctx.issueDir, ARTIFACTS.initialRamblings);
  if (!fileExists(ramblingsPath)) {
    const content = `# ${ctx.title}\n\n> ${ctx.repo}#${ctx.number}\n\n${ctx.body ?? ""}`;
    writeFile(ramblingsPath, content);
    log("Saved initial-ramblings.md");
  }

  // Label management
  await ensureLabelsExist(ctx.repo);
  await removeLabel(ctx.repo, ctx.number, cfg.triggerLabel);
  await setLabel(ctx.repo, ctx.number, "auto-claude-in-progress");

  try {
    // Step 1: Plan (runs once)
    const planOk = await STEP_RUNNERS.plan(ctx);
    if (!planOk) {
      await handleFailure(ctx, "plan");
      return;
    }
    if (untilStep === "plan") {
      log(`Pipeline paused after "plan" (--until plan)`);
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
      const implOk = await STEP_RUNNERS.implement(ctx);
      if (!implOk) {
        await handleFailure(ctx, "implement");
        return;
      }
      if (untilStep === "implement") {
        log(`Pipeline paused after "implement" (--until implement)`);
        return;
      }

      // Simplify
      const simplifyOk = await STEP_RUNNERS.simplify(ctx);
      if (!simplifyOk) {
        await handleFailure(ctx, "simplify");
        return;
      }
      if (untilStep === "simplify") {
        log(`Pipeline paused after "simplify" (--until simplify)`);
        return;
      }

      // Review
      const reviewOk = await STEP_RUNNERS.review(ctx);
      if (!reviewOk) {
        await handleFailure(ctx, "review");
        return;
      }
      if (untilStep === "review") {
        log(`Pipeline paused after "review" (--until review)`);
        return;
      }

      // Check review result
      if (isReviewPass(ctx)) {
        // Review passed — create PR
        const prUrl = await createPr(ctx);
        await removeLabel(ctx.repo, ctx.number, "auto-claude-in-progress");
        await setLabel(ctx.repo, ctx.number, "auto-claude-review");
        log(`Pipeline complete for ${ctx.repo}#${ctx.number} — ${prUrl}`);
        return;
      }

      // Review failed
      if (attempt < maxRetries) {
        log(`Review did not pass (attempt ${attempt + 1}/${maxRetries + 1}), retrying implement→simplify→review…`);
      }
    }

    // All retries exhausted
    await removeLabel(ctx.repo, ctx.number, "auto-claude-in-progress");
    await setLabel(ctx.repo, ctx.number, "auto-claude-failed");
    await ghRaw([
      "issue",
      "comment",
      String(ctx.number),
      "--repo",
      ctx.repo,
      "--body",
      `auto-claude: review did not pass after ${maxRetries + 1} attempts. Labelled \`auto-claude-failed\`.`,
    ]);
    log(`Pipeline failed after ${maxRetries + 1} review attempts for ${ctx.repo}#${ctx.number}`);
  } finally {
    await checkoutMain();
  }
}

function clearArtifact(ctx: IssueContext, artifact: string): void {
  const path = join(ctx.issueDir, artifact);
  try {
    rmSync(path);
  } catch {
    // File may not exist — that's fine
  }
}

function isReviewPass(ctx: IssueContext): boolean {
  const reviewPath = join(ctx.issueDir, ARTIFACTS.review);
  if (!fileExists(reviewPath)) return false;
  const content = readFile(reviewPath);
  const firstLine = content.split("\n")[0].trim();
  return firstLine.toUpperCase().startsWith("PASS");
}

async function handleFailure(ctx: IssueContext, stepName: string): Promise<void> {
  await removeLabel(ctx.repo, ctx.number, "auto-claude-in-progress");
  await setLabel(ctx.repo, ctx.number, "auto-claude-failed");
  log(`Pipeline stopped at "${stepName}" for ${ctx.repo}#${ctx.number}`);
}

async function checkoutMain(): Promise<void> {
  await git(["checkout", getConfig().mainBranch]).catch(() => {});

  const stashList = await execSafe("git", ["stash", "list"]);
  if (stashList.ok) {
    const lines = stashList.stdout.split("\n");
    const idx = lines.findIndex((l) => l.includes("auto-claude: before switching to"));
    if (idx >= 0) {
      await execSafe("git", ["stash", "pop", `stash@{${idx}}`]);
      log("Restored stashed changes");
    }
  }
}
