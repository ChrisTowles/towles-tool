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

// Module-scope singleton state — shared across all callers
let _ws: WebSocket | null = null;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _refCount = 0;
const connected = ref(false);
const lastEvent = ref<BoardEvent | null>(null);
const handlers = new Map<string, Set<EventHandler>>();

function getWsUrl(): string {
  const loc = window.location;
  const protocol = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${loc.host}/_ws`;
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

function scheduleReconnect() {
  if (_reconnectTimer) return;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    connect();
  }, 3000);
}

function connect() {
  if (_ws?.readyState === WebSocket.OPEN) return;

  try {
    _ws = new WebSocket(getWsUrl());

    _ws.onopen = () => {
      connected.value = true;
      if (_reconnectTimer) {
        clearTimeout(_reconnectTimer);
        _reconnectTimer = null;
      }
    };

    _ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as BoardEvent;
        lastEvent.value = data;
        dispatch(data);
      } catch {
        // Ignore malformed messages
      }
    };

    _ws.onclose = () => {
      connected.value = false;
      if (_refCount > 0) scheduleReconnect();
    };

    _ws.onerror = () => {
      connected.value = false;
      _ws?.close();
    };
  } catch {
    connected.value = false;
    scheduleReconnect();
  }
}

function disconnect() {
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  _ws?.close();
  _ws = null;
  connected.value = false;
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
  if (_ws?.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify(data));
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

  const handleWorkflowCompleted = (_event: BoardEvent) => {
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

export function useWebSocket() {
  onMounted(() => {
    _refCount++;
    if (_refCount === 1) connect();
  });

  onUnmounted(() => {
    _refCount--;
    if (_refCount <= 0) {
      _refCount = 0;
      disconnect();
    }
  });

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
