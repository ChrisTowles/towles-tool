import { renameSync } from "node:fs";
import { join } from "node:path";

import consola from "consola";

import { getConfig } from "../config.js";
import { ARTIFACTS, STEP_LABELS, TEMPLATES } from "../prompt-templates/index.js";
import { buildTokens, fileExists, log, logStep, resolveTemplate, runClaude } from "../utils.js";
import type { IssueContext } from "../utils.js";

export async function stepPlanAnnotations(ctx: IssueContext): Promise<boolean> {
  const annotationsPath = join(ctx.issueDir, ARTIFACTS.planAnnotations);
  const addressedPath = join(ctx.issueDir, ARTIFACTS.planAnnotationsAddressed);

  if (!fileExists(annotationsPath)) {
    return true;
  }

  if (fileExists(addressedPath)) {
    logStep(STEP_LABELS.planAnnotations, ctx, true);
    return true;
  }

  logStep(STEP_LABELS.planAnnotations, ctx);
  log("Found plan-annotations.md — addressing reviewer notes");

  const tokens = buildTokens(ctx);
  const promptFile = resolveTemplate(TEMPLATES.planAnnotations, tokens, ctx.issueDir);

  const result = await runClaude({
    promptFile,
    maxTurns: getConfig().maxTurns,
  });

  if (result.is_error) {
    consola.error(`Plan-Annotations step failed: ${result.result}`);
    return false;
  }

  renameSync(annotationsPath, addressedPath);
  log("Annotations addressed — renamed to plan-annotations-addressed.md");

  return true;
}
