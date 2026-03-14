import { join } from "node:path";

import { getConfig } from "./config.js";
import { ARTIFACTS, PIPELINE_STEPS } from "./prompt-templates/index.js";
import type { StepName } from "./prompt-templates/index.js";
import { stepImplement } from "./steps/implement.js";
import { stepPlan } from "./steps/plan.js";
import { stepReview } from "./steps/review.js";
import { ensureDir, execSafe, fileExists, git, log, readFile, writeFile } from "./utils.js";
import type { IssueContext } from "./utils.js";

// TODO: replace placeholder with real stepSimplify once implemented
const stepSimplifyPlaceholder = async (_ctx: IssueContext): Promise<boolean> => true;

const STEP_RUNNERS: Record<StepName, (ctx: IssueContext) => Promise<boolean>> = {
  plan: stepPlan,
  implement: stepImplement,
  simplify: stepSimplifyPlaceholder,
  review: stepReview,
};

export { type StepName, STEP_NAMES } from "./prompt-templates/index.js";

export async function runPipeline(ctx: IssueContext, untilStep?: StepName): Promise<void> {
  log(`Pipeline starting for ${ctx.repo}#${ctx.number}: ${ctx.title}`);

  ensureDir(ctx.issueDir);
  const ramblingsPath = join(ctx.issueDir, ARTIFACTS.initialRamblings);
  if (!fileExists(ramblingsPath)) {
    const content = `# ${ctx.title}\n\n> ${ctx.repo}#${ctx.number}\n\n${ctx.body ?? ""}`;
    writeFile(ramblingsPath, content);
    log("Saved initial-ramblings.md");
  }

  try {
    for (const step of PIPELINE_STEPS) {
      const runner = STEP_RUNNERS[step.name];
      const success = await runner(ctx);

      if (!success) {
        log(`Pipeline stopped at "${step.name}" for ${ctx.repo}#${ctx.number}`);
        return;
      }

      if (untilStep && step.name === untilStep) {
        log(`Pipeline paused after "${step.name}" (--until ${untilStep})`);
        return;
      }
    }

    const prUrlPath = join(ctx.issueDir, ARTIFACTS.prUrl);
    const prUrl = fileExists(prUrlPath) ? readFile(prUrlPath).trim() : "";
    const prSuffix = prUrl ? ` — ${prUrl}` : "";
    log(`Pipeline complete for ${ctx.repo}#${ctx.number}${prSuffix}`);
  } finally {
    await checkoutMain();
  }
}

async function checkoutMain(): Promise<void> {
  await git(["checkout", getConfig().mainBranch]).catch(() => {});

  // Restore any stash created by ensureBranch, searching by message instead of assuming top
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
