import { join } from "node:path";

import { getConfig } from "./config.js";
import { ARTIFACTS, PIPELINE_STEPS } from "./prompt-templates/index.js";
import type { StepName } from "./prompt-templates/index.js";
import { stepCreatePR } from "./steps/create-pr.js";
import { stepImplement } from "./steps/implement.js";
import { stepPlanAnnotations } from "./steps/plan-annotations.js";
import { stepPlanImplementation } from "./steps/plan-implementation.js";
import { stepPlan } from "./steps/plan.js";
import { stepRemoveLabel } from "./steps/remove-label.js";
import { stepResearch } from "./steps/research.js";
import { stepReview } from "./steps/review.js";
import { ensureDir, fileExists, git, log, readFile, writeFile } from "./utils.js";
import type { IssueContext } from "./utils.js";

const STEP_RUNNERS: Record<StepName, (ctx: IssueContext) => Promise<boolean>> = {
  research: stepResearch,
  plan: stepPlan,
  "plan-annotations": stepPlanAnnotations,
  "plan-implementation": stepPlanImplementation,
  implement: stepImplement,
  review: stepReview,
  "create-pr": stepCreatePR,
  "remove-label": stepRemoveLabel,
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

  for (const step of PIPELINE_STEPS) {
    const runner = STEP_RUNNERS[step.name];
    const success = await runner(ctx);

    if (!success) {
      log(`Pipeline stopped at "${step.name}" for ${ctx.repo}#${ctx.number}`);
      await checkoutMain();
      return;
    }

    if (untilStep && step.name === untilStep) {
      log(`Pipeline paused after "${step.name}" (--until ${untilStep})`);
      await checkoutMain();
      return;
    }
  }

  const prUrlPath = join(ctx.issueDir, ARTIFACTS.prUrl);
  const prUrl = fileExists(prUrlPath) ? readFile(prUrlPath).trim() : "";
  const prSuffix = prUrl ? ` — ${prUrl}` : "";
  log(`Pipeline complete for ${ctx.repo}#${ctx.number}${prSuffix}`);
  await checkoutMain();
}

async function checkoutMain(): Promise<void> {
  await git(["checkout", getConfig().mainBranch]).catch(() => {});
}
