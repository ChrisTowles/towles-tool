import type { Column, CardStatus } from "~/utils/constants";

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
  dependsOn: string | null;
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

export function useCards(boardId: Ref<number> = ref(1)) {
  const cards = ref<Card[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchCards() {
    loading.value = true;
    error.value = null;
    try {
      const data = await $fetch<Card[]>("/api/cards", {
        query: { boardId: boardId.value },
      });
      cards.value = data;
    } catch (e) {
      error.value = e instanceof Error ? e.message : "Failed to fetch cards";
    } finally {
      loading.value = false;
    }
  }

  async function moveCard(cardId: number, column: Column, position: number) {
    try {
      await $fetch(`/api/cards/${cardId}/move`, {
        method: "POST",
        body: { column, position },
      });
      const card = cards.value.find((c) => c.id === cardId);
      if (card) {
        card.column = column;
        card.position = position;
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : "Failed to move card";
      await fetchCards();
    }
  }

  async function createCard(data: {
    title: string;
    description?: string;
    repoId?: number;
    workflowId?: string;
    executionMode?: string;
    branchMode?: string;
  }) {
    try {
      const card = await $fetch<Card>("/api/cards", {
        method: "POST",
        body: { ...data, boardId: boardId.value },
      });
      cards.value.push(card);
      return card;
    } catch (e) {
      error.value = e instanceof Error ? e.message : "Failed to create card";
      return null;
    }
  }

  onMounted(fetchCards);

  return { cards, loading, error, fetchCards, moveCard, createCard };
}
