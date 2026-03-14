import { join } from "node:path";

import { ARTIFACTS, STEP_LABELS, TEMPLATES } from "../prompt-templates/index.js";
import { runStepWithArtifact } from "../utils.js";
import type { IssueContext } from "../utils.js";

export async function stepSimplify(ctx: IssueContext): Promise<boolean> {
  return runStepWithArtifact({
    stepName: STEP_LABELS.simplify,
    ctx,
    artifactPath: join(ctx.issueDir, ARTIFACTS.simplifySummary),
    templateName: TEMPLATES.simplify,
  });
}
