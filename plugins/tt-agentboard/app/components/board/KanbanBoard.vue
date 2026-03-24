<script setup lang="ts">
import { COLUMNS } from "~/utils/constants";
import type { Column } from "~/utils/constants";

const { cards, loading, error, fetchCards, moveCard } = useCards();
const { columnCards, totalCards, activeCards } = useBoard(cards);

const emit = defineEmits<{
  cardSelected: [cardId: number];
}>();

async function handleCardMoved(cardId: number, column: Column, position: number) {
  await moveCard(cardId, column, position);
}

// Refresh cards periodically for live status updates
const refreshInterval = ref<ReturnType<typeof setInterval> | null>(null);
onMounted(() => {
  refreshInterval.value = setInterval(fetchCards, 5000);
});
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
        >
          Workspaces
        </NuxtLink>
        <button
          class="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-700"
          @click="fetchCards"
        >
          ↻ Refresh
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
  </div>
</template>
