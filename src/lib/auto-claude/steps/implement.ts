import { join } from "node:path";

import consola from "consola";

import { getConfig } from "../config.js";
import { ARTIFACTS, STEP_LABELS, TEMPLATES } from "../prompt-templates/index.js";
import {
  buildTokens,
  fileExists,
  git,
  log,
  logStep,
  resolveTemplate,
  runClaude,
} from "../utils.js";
import type { IssueContext } from "../utils.js";

export async function stepImplement(ctx: IssueContext): Promise<boolean> {
  const completedPath = join(ctx.issueDir, ARTIFACTS.completedSummary);
  const maxIterations = getConfig().maxImplementIterations;

  if (fileExists(completedPath)) {
    logStep(STEP_LABELS.implement, ctx, true);
    return true;
  }

  logStep(STEP_LABELS.implement, ctx);

  await git(["checkout", ctx.branch]);

  for (let i = 1; i <= maxIterations; i++) {
    log(`Implementation iteration ${i}/${maxIterations}`);

    const tokens = buildTokens(ctx);
    const promptFile = resolveTemplate(TEMPLATES.implement, tokens, ctx.issueDir);

    const result = await runClaude({
      promptFile,
      permissionMode: "acceptEdits",
      maxTurns: getConfig().maxTurns,
    });

    if (result.is_error) {
      consola.error(`Implement iteration ${i} failed: ${result.result}`);
      return false;
    }

    if (fileExists(completedPath)) {
      log(`Implementation complete after ${i} iteration(s)`);
      return true;
    }

    log(`Iteration ${i} finished but completed-summary.md not yet created — tasks remain`);
  }

  consola.error(`Implementation did not complete after ${maxIterations} iterations`);
  return false;
}
