<script setup lang="ts">
import { COLUMNS } from "~/utils/constants";
import type { Column } from "~/utils/constants";
import type { Card } from "~/stores/cards";

const store = useCardStore();
const { cards, loading, error, columnCards, totalCards, activeCards } = storeToRefs(store);

const props = defineProps<{
  isDictating?: boolean;
  newCardPrefill?: string;
  showNewCard?: boolean;
  refreshTrigger?: number;
}>();

const emit = defineEmits<{
  cardSelected: [cardId: number];
  toggleDictation: [];
  newCardClosed: [];
  showHelp: [];
}>();

const showNewCardForm = ref(false);
const showImportModal = ref(false);

const { data: githubStatus } = useFetch<{ configured: boolean }>("/api/github/status");
const { data: health } = useFetch<{ tmuxInstalled: boolean; ghAuthenticated: boolean }>(
  "/api/health",
);
const { data: repos, refresh: refreshRepos } = useFetch<{ id: number }[]>("/api/repos");
const { data: slots, refresh: refreshSlots } = useFetch<{ id: number }[]>("/api/slots");

const showOnboarding = computed(() => !repos.value?.length && !slots.value?.length);

async function onOnboardingComplete() {
  await Promise.all([refreshRepos(), refreshSlots(), store.fetchCards()]);
}

// Sync external showNewCard prop
watch(
  () => props.showNewCard,
  (v) => {
    if (v) showNewCardForm.value = true;
  },
);

// Refresh board when parent triggers it
watch(
  () => props.refreshTrigger,
  () => store.fetchCards(),
);

function onCardCreated() {
  showNewCardForm.value = false;
  emit("newCardClosed");
  store.fetchCards();
}

function onIssuesImported() {
  showImportModal.value = false;
  store.fetchCards();
}

async function handleCardMoved(cardId: number, column: Column, position: number) {
  await store.moveCard(cardId, column, position);
}

async function handleClearDone() {
  await $fetch("/api/cards/clear-done", { method: "POST" });
  await store.fetchCards();
}

// Stale-data fallback — WS handles real-time, this catches missed events
useIntervalFn(() => store.fetchCards(), 60_000);
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

      <!-- Break reminder widget -->
      <ClientOnly>
        <BreaksBreakWidget class="hidden sm:block" />
      </ClientOnly>

      <div class="flex items-center gap-2">
        <div class="relative">
          <input
            v-model="filterQuery"
            type="text"
            placeholder="Filter cards..."
            class="w-48 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 pl-8 text-xs text-zinc-200 placeholder-zinc-500 transition-colors focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
          />
          <span class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500 text-xs">⌕</span>
          <button
            v-if="filterQuery"
            class="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 text-xs"
            @click="filterQuery = ''"
            title="Clear filter"
          >
            ✕
          </button>
        </div>
        <button
          class="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:border-zinc-600 hover:bg-zinc-700 hover:text-zinc-200"
          title="Keyboard shortcuts (?)"
          @click="emit('showHelp')"
        >
          <span class="font-mono">?</span>
        </button>
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
          title="Voice dictation — create cards or respond hands-free (D)"
        >
          🎙 Dictate
        </button>
        <button
          v-if="githubStatus?.configured"
          class="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-700"
          title="Import GitHub issues as cards"
          @click="showImportModal = true"
        >
          Import Issues
        </button>
        <button
          class="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-700"
          title="Refresh board data (R)"
          @click="store.fetchCards()"
        >
          ↻ Refresh
        </button>
        <button
          class="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-500"
          title="Create a new card (N)"
          @click="showNewCardForm = true"
        >
          + New Card
        </button>
      </div>
    </header>

    <!-- Health warnings -->
    <div
      v-if="health && (!health.tmuxInstalled || !health.ghAuthenticated)"
      class="space-y-1 px-4 pt-2 sm:px-6"
    >
      <div
        v-if="!health.tmuxInstalled"
        class="flex items-center gap-2 rounded-lg border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-400"
      >
        <span class="font-semibold">tmux not found</span>
        <span class="text-red-500/70">
          — agent execution requires tmux. Install with
          <code class="rounded bg-red-950 px-1 py-0.5 font-mono text-red-400"
            >sudo apt install tmux</code
          >
          or
          <code class="rounded bg-red-950 px-1 py-0.5 font-mono text-red-400"
            >brew install tmux</code
          >, then restart AgentBoard.
        </span>
      </div>
      <div
        v-if="!health.ghAuthenticated"
        class="flex items-center gap-2 rounded-lg border border-amber-900 bg-amber-950/50 px-3 py-2 text-xs text-amber-400"
      >
        <span class="font-semibold">gh CLI not authenticated</span>
        <span class="text-amber-500/70">
          — GitHub features (issues, PRs, label sync) are disabled. Run
          <code class="rounded bg-amber-950 px-1 py-0.5 font-mono text-amber-400"
            >gh auth login</code
          >
          in your shell, then restart AgentBoard.
        </span>
      </div>
    </div>

    <!-- Break reminder prompt — big, centered, unmissable -->
    <ClientOnly>
      <BreaksBreakPrompt />
    </ClientOnly>

    <!-- Onboarding prompt (no repos & no slots) -->
    <div v-if="!loading && showOnboarding" class="px-4 py-8 sm:px-6">
      <div
        class="mx-auto flex max-w-md flex-col items-center rounded-lg border border-dashed border-zinc-800 py-12 text-center"
      >
        <p class="mb-2 text-sm font-semibold text-zinc-300">Welcome to AgentBoard</p>
        <p class="mb-4 text-xs text-zinc-500">
          Set up your workspace slots to start running agents on your repos.
        </p>
        <NuxtLink
          to="/workspaces/setup"
          class="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500"
        >
          Run Setup Wizard
        </NuxtLink>
      </div>
    </div>

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
        Could not load cards. Check the server logs for details.
      </div>
    </div>

    <!-- Columns -->
    <div v-else class="flex flex-1 gap-3 overflow-x-auto px-3 py-3 sm:gap-4 sm:px-6 sm:py-4">
      <BoardKanbanColumn
        v-for="col in COLUMNS"
        :key="col"
        :column="col"
        :cards="filteredColumnCards[col]"
        class="shrink-0"
        @card-moved="handleCardMoved"
        @card-selected="(id: number) => emit('cardSelected', id)"
        @clear-done="handleClearDone"
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
