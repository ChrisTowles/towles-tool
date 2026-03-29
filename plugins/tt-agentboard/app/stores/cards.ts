import { defineStore } from "pinia";
import { COLUMNS } from "~/utils/constants";
import type { Column, CardStatus } from "~/utils/constants";
import type {
  BoardEvent,
  CardMovedEvent,
  CardStatusChangedEvent,
} from "~/composables/useWebSocket";

export interface Card {
  id: number;
  boardId: number;
  title: string;
  description: string | null;
  repoId: number | null;
  column: Column;
  position: number;
  executionMode: "headless" | "interactive";
  status: CardStatus;
  planId: number | null;
  dependsOn: number[];
  workflowId: string | null;
  githubIssueNumber: number | null;
  githubPrNumber: number | null;
  currentStepId: string | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
  branch: string | null;
  repo?: { name: string; org: string | null; githubUrl: string | null } | null;
}

export const useCardStore = defineStore("cards", () => {
  const cards = ref<Card[]>([]);
  const selectedCardId = ref<number | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  // --- Getters ---

  const selectedCard = computed(() =>
    selectedCardId.value ? (cards.value.find((c) => c.id === selectedCardId.value) ?? null) : null,
  );

  const columnCards = computed(() => {
    const grouped: Record<Column, Card[]> = {
      ready: [],
      in_progress: [],
      simplify_review: [],
      review: [],
      done: [],
      archived: [],
    };

    for (const card of cards.value) {
      const col = card.column as Column;
      if (grouped[col]) {
        grouped[col].push(card);
      }
    }

    for (const col of COLUMNS) {
      grouped[col].sort((a, b) => a.position - b.position);
    }

    return grouped;
  });

  const totalCards = computed(() => cards.value.length);

  const activeCards = computed(() => cards.value.filter((c) => c.status === "running").length);

  // --- Actions ---

  async function fetchCards(boardId = 1) {
    loading.value = true;
    error.value = null;
    try {
      const data = await $fetch<Card[]>("/api/cards", {
        query: { boardId },
      });
      cards.value = data;
    } catch (e) {
      error.value = e instanceof Error ? e.message : "Failed to fetch cards";
    } finally {
      loading.value = false;
    }
  }

  async function moveCard(cardId: number, column: Column, position: number) {
    // Optimistic update
    const card = cards.value.find((c) => c.id === cardId);
    const prevColumn = card?.column;
    const prevPosition = card?.position;
    if (card) {
      card.column = column;
      card.position = position;
    }

    try {
      await $fetch(`/api/cards/${cardId}/move`, {
        method: "POST",
        body: { column, position },
      });
    } catch (e) {
      error.value = e instanceof Error ? e.message : "Failed to move card";
      // Revert on failure
      if (card && prevColumn !== undefined && prevPosition !== undefined) {
        card.column = prevColumn;
        card.position = prevPosition;
      }
      await fetchCards();
    }
  }

  async function createCard(data: {
    title: string;
    description?: string;
    repoId?: number;
    column?: string;
    workflowId?: string;
    executionMode?: string;
    branchMode?: string;
  }) {
    try {
      const card = await $fetch<Card>("/api/cards", {
        method: "POST",
        body: { ...data, boardId: 1 },
      });
      cards.value.push(card);
      return card;
    } catch (e) {
      error.value = e instanceof Error ? e.message : "Failed to create card";
      return null;
    }
  }

  async function deleteCard(cardId: number) {
    try {
      await $fetch(`/api/cards/${cardId}`, { method: "DELETE" });
      cards.value = cards.value.filter((c) => c.id !== cardId);
      if (selectedCardId.value === cardId) {
        selectedCardId.value = null;
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : "Failed to delete card";
    }
  }

  function selectCard(cardId: number | null) {
    selectedCardId.value = cardId;
  }

  // --- WebSocket integration ---

  let wsBound = false;

  function bindWebSocket(ws: {
    on: (type: string, handler: (event: BoardEvent) => void) => void;
    off: (type: string, handler: (event: BoardEvent) => void) => void;
  }) {
    if (wsBound) return;
    wsBound = true;
    const handleMoved = (event: BoardEvent) => {
      const { cardId, toColumn } = event as CardMovedEvent;
      const card = cards.value.find((c) => c.id === cardId);
      if (card) {
        card.column = toColumn;
      } else {
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

    const handleCreated = (event: BoardEvent) => {
      // A card was created elsewhere — full refresh to pick it up
      fetchCards();
    };

    const handleDeleted = (event: BoardEvent) => {
      const { cardId } = event;
      if (typeof cardId === "number") {
        cards.value = cards.value.filter((c) => c.id !== cardId);
        if (selectedCardId.value === cardId) {
          selectedCardId.value = null;
        }
      }
    };

    const handleWorkflowCompleted = () => {
      fetchCards();
    };

    ws.on("card:moved", handleMoved);
    ws.on("card:status-changed", handleStatusChanged);
    ws.on("card:created", handleCreated);
    ws.on("card:deleted", handleDeleted);
    ws.on("workflow:completed", handleWorkflowCompleted);
  }

  return {
    // State
    cards,
    selectedCardId,
    loading,
    error,
    // Getters
    selectedCard,
    columnCards,
    totalCards,
    activeCards,
    // Actions
    fetchCards,
    moveCard,
    createCard,
    deleteCard,
    selectCard,
    bindWebSocket,
  };
});
