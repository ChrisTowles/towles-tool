import { join } from "node:path";

import consola from "consola";

import { getConfig } from "../config.js";
import { ARTIFACTS, STEP_LABELS, TEMPLATES } from "../prompt-templates/index.js";
import { fileExists, readFile } from "../../../utils/fs.js";
import { git } from "../../../utils/git/exec.js";
import { runClaude } from "../claude-cli.js";
import { resolveTemplate } from "../templates.js";
import { buildTokens, log, logStep } from "../utils.js";
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

  const reviewPath = join(ctx.issueDir, ARTIFACTS.review);
  const reviewFeedback = fileExists(reviewPath) ? readFile(reviewPath) : "";

  for (let i = 1; i <= maxIterations; i++) {
    log(`Implementation iteration ${i}/${maxIterations}`);

    const tokens = buildTokens(ctx, { REVIEW_FEEDBACK: reviewFeedback });
    const promptFile = resolveTemplate(TEMPLATES.implement, tokens, ctx.issueDir);

    const result = await runClaude({
      promptFile,
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
