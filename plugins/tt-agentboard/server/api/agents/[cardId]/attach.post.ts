import { ttydManager } from "~~/server/domains/infra/ttyd-manager";
import { tmuxManager } from "~~/server/domains/infra/tmux-manager";
import { getCardId } from "~~/server/utils/params";

export default defineEventHandler(async (event) => {
  const cardId = getCardId(event);

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
