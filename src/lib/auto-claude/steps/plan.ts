import { join } from "node:path";

import { ARTIFACTS, STEP_LABELS, TEMPLATES } from "../prompt-templates/index.js";
import { ensureBranch, runStepWithArtifact } from "../utils.js";
import type { IssueContext } from "../utils.js";

export async function stepPlan(ctx: IssueContext): Promise<boolean> {
  await ensureBranch(ctx.branch);

  return runStepWithArtifact({
    stepName: STEP_LABELS.plan,
    ctx,
    artifactPath: join(ctx.issueDir, ARTIFACTS.plan),
    templateName: TEMPLATES.plan,
  });
}
