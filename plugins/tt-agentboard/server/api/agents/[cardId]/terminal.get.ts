import { tmuxManager } from "~~/server/services/tmux-manager";

/**
 * Get the terminal output from a card's tmux session.
 * Returns the last N lines from capture-pane.
 *
 * GET /api/agents/:cardId/terminal
 */
export default defineEventHandler(async (event) => {
  const cardId = Number(getRouterParam(event, "cardId"));

  if (!cardId || Number.isNaN(cardId)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid cardId" });
  }

  const sessionName = `card-${cardId}`;

  if (!tmuxManager.sessionExists(sessionName)) {
    return { exists: false, output: "" };
  }

  try {
    const { execSync } = await import("node:child_process");
    const output = execSync(`tmux capture-pane -t ${sessionName} -p -S -500`, {
      encoding: "utf-8",
      timeout: 3000,
    });
    return { exists: true, output };
  } catch {
    return { exists: false, output: "" };
  }
});
