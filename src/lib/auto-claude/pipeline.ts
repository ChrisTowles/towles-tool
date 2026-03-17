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
import { LABELS, ensureLabelsExist, removeLabel, setLabel } from "./labels.js";
import { execSafe, ghRaw, git } from "./shell.js";
import { ensureDir, fileExists, log, readFile, writeFile } from "./utils.js";
import type { IssueContext } from "./utils.js";

export { type StepName, STEP_NAMES } from "./prompt-templates/index.js";

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
  await setLabel(ctx.repo, ctx.number, LABELS.inProgress);

  try {
    // Step 1: Plan (runs once)
    if (!(await stepPlan(ctx))) {
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
      if (!(await stepImplement(ctx))) {
        await handleFailure(ctx, "implement");
        return;
      }
      if (untilStep === "implement") {
        log(`Pipeline paused after "implement" (--until implement)`);
        return;
      }

      // Simplify
      if (!(await stepSimplify(ctx))) {
        await handleFailure(ctx, "simplify");
        return;
      }
      if (untilStep === "simplify") {
        log(`Pipeline paused after "simplify" (--until simplify)`);
        return;
      }

      // Review
      if (!(await stepReview(ctx))) {
        await handleFailure(ctx, "review");
        return;
      }
      if (untilStep === "review") {
        log(`Pipeline paused after "review" (--until review)`);
        return;
      }

      // Check review result
      if (isReviewPass(ctx)) {
        const prUrl = await createPr(ctx);
        await removeLabel(ctx.repo, ctx.number, LABELS.inProgress);
        await setLabel(ctx.repo, ctx.number, LABELS.success);
        await setLabel(ctx.repo, ctx.number, LABELS.review);
        log(`Pipeline complete for ${ctx.repo}#${ctx.number} — ${prUrl}`);
        return;
      }

      // Review failed
      if (attempt < maxRetries) {
        log(
          `Review did not pass (attempt ${attempt + 1}/${maxRetries + 1}), retrying implement→simplify→review…`,
        );
      }
    }

    // All retries exhausted
    await handleFailure(
      ctx,
      "review",
      `auto-claude: review did not pass after ${maxRetries + 1} attempts. Labelled \`${LABELS.failed}\`.`,
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

async function handleFailure(ctx: IssueContext, stepName: string, comment?: string): Promise<void> {
  await removeLabel(ctx.repo, ctx.number, LABELS.inProgress);
  await setLabel(ctx.repo, ctx.number, LABELS.failed);
  if (comment) {
    await ghRaw(["issue", "comment", String(ctx.number), "--repo", ctx.repo, "--body", comment]);
  }
  log(`Pipeline stopped at "${stepName}" for ${ctx.repo}#${ctx.number}`);
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
      log("Restored stashed changes");
    }
  }
}
