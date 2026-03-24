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
const { data: health } = useFetch<{ tmuxInstalled: boolean; githubToken: boolean }>("/api/health");
const { data: repos } = useFetch<{ id: number }[]>("/api/repos");
const { data: slots } = useFetch<{ id: number }[]>("/api/slots");

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
onMounted(() => {
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
          title="Voice dictation — create cards or respond hands-free"
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
          title="Refresh board data"
          @click="fetchCards"
        >
          ↻ Refresh
        </button>
        <button
          class="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-500"
          title="Create a new card"
          @click="showNewCardForm = true"
        >
          + New Card
        </button>
      </div>
    </header>

    <!-- Health warnings -->
    <div
      v-if="health && (!health.tmuxInstalled || !health.githubToken)"
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
        v-if="!health.githubToken"
        class="flex items-center gap-2 rounded-lg border border-amber-900 bg-amber-950/50 px-3 py-2 text-xs text-amber-400"
      >
        <span class="font-semibold">GITHUB_TOKEN not set</span>
        <span class="text-amber-500/70">
          — GitHub features (issues, PRs, label sync) are disabled. Set
          <code class="rounded bg-amber-950 px-1 py-0.5 font-mono text-amber-400"
            >export GITHUB_TOKEN=ghp_...</code
          >
          in your shell, then restart AgentBoard.
        </span>
      </div>
    </div>

    <!-- Getting started (empty board) -->
    <div v-if="!loading && totalCards === 0" class="mx-auto max-w-xl px-6 py-8">
      <h2 class="mb-4 text-sm font-bold text-zinc-200">Getting Started</h2>
      <ol class="space-y-3 text-xs leading-relaxed text-zinc-400">
        <li class="flex items-start gap-3">
          <span
            class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
            :class="
              repos?.length ? 'bg-emerald-500/20 text-emerald-400' : 'bg-zinc-800 text-zinc-500'
            "
            >1</span
          >
          <div>
            <span class="font-semibold text-zinc-300">Configure workspaces</span>
            — Go to
            <NuxtLink to="/workspaces" class="font-medium text-blue-400 hover:underline"
              >Workspaces</NuxtLink
            >
            and add a slot: pick a repo and point it to a local git checkout.
            <span v-if="!repos?.length" class="block mt-1 text-amber-500/80"
              >No repos registered yet — adding a workspace slot will register its repo
              automatically.</span
            >
            <span v-else-if="!slots?.length" class="block mt-1 text-amber-500/80"
              >Repos found but no workspace slots configured. Add one to enable agent
              execution.</span
            >
          </div>
        </li>
        <li class="flex items-start gap-3">
          <span
            class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[10px] font-bold text-zinc-500"
            >2</span
          >
          <div>
            <span class="font-semibold text-zinc-300">Create a card</span>
            — Click
            <span class="rounded bg-blue-600/20 px-1.5 py-0.5 font-semibold text-blue-400"
              >+ New Card</span
            >
            above. Give it a title like "Fix the login bug" and select a repo.
          </div>
        </li>
        <li class="flex items-start gap-3">
          <span
            class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[10px] font-bold text-zinc-500"
            >3</span
          >
          <div>
            <span class="font-semibold text-zinc-300">Run an agent</span>
            — Drag the card to "In Progress". A Claude Code session starts in tmux. Click the card
            to see live terminal output.
          </div>
        </li>
      </ol>
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
