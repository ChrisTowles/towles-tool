<script setup lang="ts">
import { COLUMNS } from "~/utils/constants";
import type { Column } from "~/utils/constants";

const { cards, loading, error, fetchCards, moveCard } = useCards();
const { columnCards, totalCards, activeCards } = useBoard(cards);
const { connected, bindCards } = useWebSocket();

const props = defineProps<{
  isDictating?: boolean;
  newCardPrefill?: string;
  showNewCard?: boolean;
}>();

const emit = defineEmits<{
  cardSelected: [cardId: number];
  toggleDictation: [];
  newCardClosed: [];
}>();

const showNewCardForm = ref(false);
const showImportModal = ref(false);

const { data: githubStatus } = useFetch<{ configured: boolean }>("/api/github/status");

// Sync external showNewCard prop
watch(
  () => props.showNewCard,
  (v) => {
    if (v) showNewCardForm.value = true;
  },
);

function onCardCreated() {
  showNewCardForm.value = false;
  emit("newCardClosed");
  fetchCards();
}

function onIssuesImported() {
  showImportModal.value = false;
  fetchCards();
}

async function handleCardMoved(cardId: number, column: Column, position: number) {
  await moveCard(cardId, column, position);
}

// Bind WebSocket events to cards for real-time updates
let unbindCards: (() => void) | null = null;
onMounted(() => {
  unbindCards = bindCards(cards, fetchCards);
});
onUnmounted(() => {
  unbindCards?.();
});

// Fallback: poll every 5s only when WebSocket is disconnected
const refreshInterval = ref<ReturnType<typeof setInterval> | null>(null);
watch(
  connected,
  (isConnected) => {
    if (isConnected) {
      if (refreshInterval.value) {
        clearInterval(refreshInterval.value);
        refreshInterval.value = null;
      }
    } else {
      if (!refreshInterval.value) {
        refreshInterval.value = setInterval(fetchCards, 5000);
      }
    }
  },
  { immediate: true },
);
onUnmounted(() => {
  if (refreshInterval.value) clearInterval(refreshInterval.value);
});
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Board header -->
    <header
      class="flex flex-col gap-3 border-b border-zinc-800 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-4"
    >
      <div class="flex items-center gap-4">
        <h1 class="font-display text-xl font-bold tracking-tight text-zinc-100">
          <span class="text-blue-400">▸</span> AgentBoard
        </h1>
        <div class="flex items-center gap-3 text-[11px] font-mono text-zinc-500">
          <span>{{ totalCards }} cards</span>
          <span class="text-zinc-700">│</span>
          <span v-if="activeCards > 0" class="text-blue-400">{{ activeCards }} running</span>
          <span v-else>idle</span>
        </div>
      </div>

      <div class="flex items-center gap-2">
        <NuxtLink
          to="/workspaces"
          class="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-700"
          title="Manage workspace slots for agent execution"
        >
          Workspaces
        </NuxtLink>
        <NuxtLink
          to="/workflows"
          class="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-700"
          title="View loaded workflow definitions"
        >
          Workflows
        </NuxtLink>
        <NuxtLink
          to="/plans"
          class="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-700"
          title="View and manage execution plans"
        >
          Plans
        </NuxtLink>
        <button
          class="rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors"
          :class="
            isDictating
              ? 'border-red-500 bg-red-500/10 text-red-400 hover:bg-red-500/20'
              : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-700'
          "
          @click="emit('toggleDictation')"
        >
          🎙 Dictate
        </button>
        <button
          v-if="githubStatus?.configured"
          class="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-700"
          @click="showImportModal = true"
        >
          Import Issues
        </button>
        <button
          class="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-700"
          @click="fetchCards"
        >
          ↻ Refresh
        </button>
        <button
          class="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-500"
          @click="showNewCardForm = true"
        >
          + New Card
        </button>
      </div>
    </header>

    <!-- Loading / error states -->
    <div v-if="loading && cards.length === 0" class="flex flex-1 items-center justify-center">
      <div class="flex items-center gap-3 text-sm text-zinc-500">
        <span
          class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-blue-400"
        />
        Loading board...
      </div>
    </div>

    <div v-else-if="error" class="flex flex-1 items-center justify-center">
      <div class="rounded-lg border border-red-900 bg-red-950/50 px-4 py-3 text-sm text-red-400">
        {{ error }}
      </div>
    </div>

    <!-- Columns -->
    <div v-else class="flex flex-1 gap-3 overflow-x-auto px-3 py-3 sm:gap-4 sm:px-6 sm:py-4">
      <BoardKanbanColumn
        v-for="col in COLUMNS"
        :key="col"
        :column="col"
        :cards="columnCards[col]"
        class="shrink-0"
        @card-moved="handleCardMoved"
        @card-selected="(id: number) => emit('cardSelected', id)"
      />
    </div>

    <!-- New card form modal -->
    <BoardNewCardForm
      v-if="showNewCardForm"
      :initial-title="newCardPrefill"
      @created="onCardCreated"
      @cancel="
        showNewCardForm = false;
        emit('newCardClosed');
      "
    />

    <!-- Import issues modal -->
    <BoardImportIssuesModal
      v-if="showImportModal"
      @imported="onIssuesImported"
      @cancel="showImportModal = false"
    />
  </div>
</template>
