import { eventBus } from "../utils/event-bus";
import { tmuxManager } from "../services/tmux-manager";

interface WsPeer {
  id: string;
  send: (data: string) => void;
}

const subscribers = new Map<string, Set<WsPeer>>();

function addSubscription(channel: string, peer: WsPeer) {
  let peers = subscribers.get(channel);
  if (!peers) {
    peers = new Set();
    subscribers.set(channel, peers);
  }
  peers.add(peer);
}

function removeSubscriptions(peer: WsPeer) {
  for (const [channel, peers] of subscribers.entries()) {
    peers.delete(peer);
    // Stop tmux capture if no more subscribers for this card channel
    if (peers.size === 0 && channel.startsWith("card:")) {
      const cardId = channel.replace("card:", "");
      tmuxManager.stopCapture(`card-${cardId}`);
    }
  }
}

function broadcast(channel: string, data: Record<string, unknown>) {
  const peers = subscribers.get(channel);
  if (!peers) return;
  const payload = JSON.stringify(data);
  for (const peer of peers) {
    peer.send(payload);
  }
}

// Forward event bus events to WebSocket clients
const forwardedEvents = [
  "card:moved",
  "card:status-changed",
  "step:started",
  "step:completed",
  "step:failed",
  "slot:claimed",
  "slot:released",
  "agent:output",
  "agent:activity",
  "agent:waiting",
  "workflow:completed",
  "github:issue-found",
] as const;

for (const event of forwardedEvents) {
  eventBus.on(event, (data: Record<string, unknown>) => {
    broadcast("board", { type: event, ...data });

    // Also broadcast to card-specific channel if cardId present
    if ("cardId" in data) {
      broadcast(`card:${data.cardId}`, { type: event, ...data });
    }
  });
}

export default defineWebSocketHandler({
  open(peer) {
    // All clients subscribe to board events by default
    addSubscription("board", peer);
  },

  message(peer, message) {
    const data = JSON.parse(message.text());

    if (data.type === "subscribe-terminal") {
      const cardId = data.cardId;
      addSubscription(`card:${cardId}`, peer);

      // Start tmux capture for this card's session
      const sessionName = `card-${cardId}`;
      if (tmuxManager.sessionExists(sessionName)) {
        tmuxManager.startCapture(sessionName, (output) => {
          broadcast(`card:${cardId}`, {
            type: "terminal-output",
            cardId,
            content: output,
          });
        });
      }
    }

    if (data.type === "unsubscribe-terminal") {
      const channel = `card:${data.cardId}`;
      const peers = subscribers.get(channel);
      if (peers) {
        peers.delete(peer);
        if (peers.size === 0) {
          tmuxManager.stopCapture(`card-${data.cardId}`);
        }
      }
    }

    if (data.type === "subscribe-activity") {
      const cardId = data.cardId;
      addSubscription(`card:${cardId}`, peer);
    }

    if (data.type === "unsubscribe-activity") {
      const channel = `card:${data.cardId}`;
      const peers = subscribers.get(channel);
      if (peers) {
        peers.delete(peer);
      }
    }
  },

  close(peer) {
    removeSubscriptions(peer);
  },
});
