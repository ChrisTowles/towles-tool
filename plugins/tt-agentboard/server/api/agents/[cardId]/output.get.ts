import { existsSync, readFileSync } from "node:fs";
import { getCardId } from "~~/server/utils/params";
import { getCardLogPath } from "~~/server/domains/execution/workflow-helpers";

export default defineEventHandler(async (event) => {
  const cardId = getCardId(event);
  const logPath = getCardLogPath(cardId);

  if (!existsSync(logPath)) {
    return { exists: false, lines: [] };
  }

  const content = readFileSync(logPath, "utf-8").trim();
  const lines = content ? content.split("\n") : [];
  return { exists: true, lines };
});
