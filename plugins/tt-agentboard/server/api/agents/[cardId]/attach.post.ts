import { ttydManager } from "~~/server/services/ttyd-manager";
import { tmuxManager } from "~~/server/services/tmux-manager";

export default defineEventHandler(async (event) => {
  const cardId = Number(getRouterParam(event, "cardId"));

  if (!cardId || Number.isNaN(cardId)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid cardId" });
  }

  const sessionName = `card-${cardId}`;
  if (!tmuxManager.sessionExists(sessionName)) {
    throw createError({ statusCode: 404, statusMessage: "No tmux session for this card" });
  }

  if (!ttydManager.isAvailable()) {
    throw createError({ statusCode: 503, statusMessage: "ttyd is not installed" });
  }

  const body = await readBody(event);
  const action = body?.action ?? "attach";

  if (action === "detach") {
    const detached = ttydManager.detach(cardId);
    return { detached };
  }

  const { port, url } = ttydManager.attach(cardId);
  return { attached: true, port, url };
});
