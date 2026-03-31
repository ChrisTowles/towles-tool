import { tmuxManager } from "~~/server/domains/infra/tmux-manager";
import { getCardId } from "~~/server/utils/params";
import { ptyExecShell } from "~~/server/domains/infra/pty-exec";

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
    const result = await ptyExecShell(`tmux capture-pane -t ${sessionName} -p -e -S -500`, {
      timeout: 3000,
    });
    return { exists: true, output: result.stdout };
  } catch {
    return { exists: false, output: "" };
  }
});
