import { getConfig } from "../config.js";
import { STEP_LABELS } from "../prompt-templates/index.js";
import { ghRaw, log, logStep } from "../utils.js";
import type { IssueContext } from "../utils.js";

export async function stepRemoveLabel(ctx: IssueContext): Promise<boolean> {
  logStep(STEP_LABELS.removeLabel, ctx);

  const cfg = getConfig();
  await ghRaw([
    "issue",
    "edit",
    String(ctx.number),
    "--repo",
    ctx.repo,
    "--remove-label",
    cfg.triggerLabel,
  ]);

  log(`Removed "${cfg.triggerLabel}" label from ${ctx.repo}#${ctx.number}`);
  return true;
}
