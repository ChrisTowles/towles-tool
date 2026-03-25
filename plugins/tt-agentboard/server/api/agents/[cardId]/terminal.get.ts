import { tmuxManager } from "~~/server/services/tmux-manager";
import { getCardId } from "~~/server/utils/params";

/**
 * Get the terminal output from a card's tmux session.
 * Returns the last N lines from capture-pane.
 *
 * GET /api/agents/:cardId/terminal
 */
export default defineEventHandler(async (event) => {
  const cardId = getCardId(event);

  const sessionName = `card-${cardId}`;

  if (!tmuxManager.sessionExists(sessionName)) {
    return { exists: false, output: "" };
  }

  try {
    const { execSync } = await import("node:child_process");
    const output = execSync(`tmux capture-pane -t ${sessionName} -p -e -S -500`, {
      encoding: "utf-8",
      timeout: 3000,
    });
    return { exists: true, output };
  } catch {
    return { exists: false, output: "" };
  }
});
