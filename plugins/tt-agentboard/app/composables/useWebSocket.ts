import type { Card } from "~/composables/useCards";
import type { CardStatus, Column } from "~/utils/constants";

export interface BoardEvent {
  type: string;
  cardId?: number;
  [key: string]: unknown;
}

export interface CardMovedEvent extends BoardEvent {
  type: "card:moved";
  cardId: number;
  fromColumn: Column;
  toColumn: Column;
}

export interface CardStatusChangedEvent extends BoardEvent {
  type: "card:status-changed";
  cardId: number;
  status: CardStatus;
}

export interface AgentOutputEvent extends BoardEvent {
  type: "agent:output";
  cardId: number;
  content: string;
}

export interface WorkflowCompletedEvent extends BoardEvent {
  type: "workflow:completed";
  cardId: number;
  status: "completed" | "failed";
}

type EventHandler = (event: BoardEvent) => void;

export function useWebSocket() {
  const connected = ref(false);
  const lastEvent = ref<BoardEvent | null>(null);

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const handlers = new Map<string, Set<EventHandler>>();

  function getWsUrl(): string {
    const loc = window.location;
    const protocol = loc.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${loc.host}/_ws`;
  }

  function connect() {
    if (ws?.readyState === WebSocket.OPEN) return;

    try {
      ws = new WebSocket(getWsUrl());

      ws.onopen = () => {
        connected.value = true;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as BoardEvent;
          lastEvent.value = data;
          dispatch(data);
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        connected.value = false;
        scheduleReconnect();
      };

      ws.onerror = () => {
        connected.value = false;
        ws?.close();
      };
    } catch {
      connected.value = false;
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 3000);
  }

  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ws?.close();
    ws = null;
    connected.value = false;
  }

  function dispatch(event: BoardEvent) {
    const typeHandlers = handlers.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        handler(event);
      }
    }
    // Also dispatch to wildcard handlers
    const wildcardHandlers = handlers.get("*");
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        handler(event);
      }
    }
  }

  function on(eventType: string, handler: EventHandler) {
    let set = handlers.get(eventType);
    if (!set) {
      set = new Set();
      handlers.set(eventType, set);
    }
    set.add(handler);
  }

  function off(eventType: string, handler: EventHandler) {
    handlers.get(eventType)?.delete(handler);
  }

  /** Send a message to the WebSocket server (e.g. subscribe-terminal) */
  function send(data: Record<string, unknown>) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  /** Subscribe to terminal output for a specific card */
  function subscribeTerminal(cardId: number) {
    send({ type: "subscribe-terminal", cardId });
  }

  /** Unsubscribe from terminal output for a specific card */
  function unsubscribeTerminal(cardId: number) {
    send({ type: "unsubscribe-terminal", cardId });
  }

  /**
   * Integrate with useCards — update card list reactively from WebSocket events.
   * Returns a cleanup function.
   */
  function bindCards(cards: Ref<Card[]>, fetchCards: () => Promise<void>) {
    const handleMoved = (event: BoardEvent) => {
      const { cardId, toColumn } = event as CardMovedEvent;
      const card = cards.value.find((c) => c.id === cardId);
      if (card) {
        card.column = toColumn;
      } else {
        // Card not in local state — full refresh
        fetchCards();
      }
    };

    const handleStatusChanged = (event: BoardEvent) => {
      const { cardId, status } = event as CardStatusChangedEvent;
      const card = cards.value.find((c) => c.id === cardId);
      if (card) {
        card.status = status;
      }
    };

    const handleWorkflowCompleted = (event: BoardEvent) => {
      // Full refresh to pick up column/status changes
      fetchCards();
    };

    on("card:moved", handleMoved);
    on("card:status-changed", handleStatusChanged);
    on("workflow:completed", handleWorkflowCompleted);

    return () => {
      off("card:moved", handleMoved);
      off("card:status-changed", handleStatusChanged);
      off("workflow:completed", handleWorkflowCompleted);
    };
  }

  onMounted(connect);
  onUnmounted(disconnect);

  return {
    connected,
    lastEvent,
    on,
    off,
    send,
    subscribeTerminal,
    unsubscribeTerminal,
    bindCards,
    connect,
    disconnect,
  };
}
