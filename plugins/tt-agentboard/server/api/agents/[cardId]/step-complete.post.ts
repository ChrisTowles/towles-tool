import { resolveStepComplete } from "~~/server/domains/execution/workflow-runner";
import { logger } from "~~/server/utils/logger";
import { getCardId } from "~~/server/utils/params";

/**
 * Callback endpoint for Claude Code Stop hook during workflow steps.
 * Called when Claude finishes a step — resolves the workflow runner's
 * pending Promise so it can check the artifact and proceed.
 *
 * POST /api/agents/:cardId/step-complete
 */
export default defineEventHandler(async (event) => {
  const cardId = getCardId(event);

  logger.info(`Step-complete callback received for card ${cardId}`);

  const resolved = resolveStepComplete(cardId);

  if (!resolved) {
    logger.warn(`No pending step callback for card ${cardId}, ignoring`);
    return { ok: true, ignored: true };
  }

  return { ok: true };
});
