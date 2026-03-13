import consola from "consola";

import { getConfig } from "../config.js";
import { STEP_LABELS } from "../prompt-templates/index.js";
import { execSafe, log, logStep } from "../utils.js";
import type { IssueContext } from "../utils.js";

export async function stepRemoveLabel(ctx: IssueContext): Promise<boolean> {
  logStep(STEP_LABELS.removeLabel, ctx);

  const cfg = getConfig();
  const result = await execSafe("gh", [
    "issue",
    "edit",
    String(ctx.number),
    "--repo",
    ctx.repo,
    "--remove-label",
    cfg.triggerLabel,
  ]);

  if (!result.ok) {
    consola.error(
      `Failed to remove label "${cfg.triggerLabel}" from ${ctx.repo}#${ctx.number}: ${result.stdout}`,
    );
    return false;
  }

  log(`Removed "${cfg.triggerLabel}" label from ${ctx.repo}#${ctx.number}`);
  return true;
}
