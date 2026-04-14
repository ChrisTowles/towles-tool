import { join } from "node:path";

import { getConfig } from "../config.js";
import { ARTIFACTS, STEP_LABELS, TEMPLATES } from "../prompt-templates/index.js";
import { fileExists, git, readFile } from "@towles/shared";
import { runClaude } from "../claude-cli.js";
import { logger } from "../logger.js";
import { resolveTemplate } from "../templates.js";
import { buildTokens, logStep } from "../utils.js";
import type { IssueContext } from "../utils.js";
import type { SpawnClaudeFn } from "../spawn-claude.js";

export async function stepImplement(ctx: IssueContext, spawnFn?: SpawnClaudeFn): Promise<boolean> {
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
    logger.info(`Implementation iteration ${i}/${maxIterations}`);

    const tokens = buildTokens(ctx, { REVIEW_FEEDBACK: reviewFeedback });
    const promptFile = resolveTemplate(TEMPLATES.implement, tokens, ctx.issueDir);

    const result = await runClaude({
      promptFile,
      maxTurns: getConfig().maxTurns,
      spawnFn,
    });

    if (result.is_error) {
      logger.error(`Implement iteration ${i} failed: ${result.result}`);
      return false;
    }

    if (fileExists(completedPath)) {
      logger.info(`Implementation complete after ${i} iteration(s)`);
      return true;
    }

    logger.warn(`Iteration ${i} finished but completed-summary.md not yet created — tasks remain`);
  }

  logger.error(`Implementation did not complete after ${maxIterations} iterations`);
  return false;
}
