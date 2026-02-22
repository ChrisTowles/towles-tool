import { join } from "node:path";

import { ARTIFACTS, STEP_LABELS, TEMPLATES } from "../prompt-templates/index.js";
import { ensureBranch, fileExists, readFile, runStepWithArtifact } from "../utils.js";
import type { IssueContext } from "../utils.js";

function isValidResearch(path: string): boolean {
  return fileExists(path) && readFile(path).length > 200;
}

export async function stepResearch(ctx: IssueContext): Promise<boolean> {
  await ensureBranch(ctx.branch);

  return runStepWithArtifact({
    stepName: STEP_LABELS.research,
    ctx,
    artifactPath: join(ctx.issueDir, ARTIFACTS.research),
    templateName: TEMPLATES.research,
    artifactValidator: isValidResearch,
  });
}
