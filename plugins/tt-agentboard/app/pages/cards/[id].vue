<script setup lang="ts">
import type { Card } from "~/composables/useCards";
import type { CardStatus } from "~/utils/constants";
import { COLUMN_LABELS } from "~/utils/constants";

const route = useRoute();
const cardId = computed(() => Number(route.params.id));

const { data: card, refresh } = await useFetch<Card>(`/api/cards/${cardId.value}`);

const terminalOutput = ref("");
const terminalExists = ref(false);

async function fetchTerminal() {
  try {
    const data = await $fetch<{ exists: boolean; output: string }>(
      `/api/agents/${cardId.value}/terminal`,
    );
    terminalExists.value = data.exists;
    terminalOutput.value = data.output;
  } catch {
    terminalExists.value = false;
  }
}

const agentInput = ref("");

async function sendResponse() {
  if (!agentInput.value.trim()) return;
  await $fetch(`/api/agents/${cardId.value}/respond`, {
    method: "POST",
    body: { response: agentInput.value },
  }).catch(() => {});
  agentInput.value = "";
}

const refreshInterval = ref<ReturnType<typeof setInterval> | null>(null);
onMounted(() => {
  fetchTerminal();
  refreshInterval.value = setInterval(() => {
    refresh();
    fetchTerminal();
  }, 2000);
});
onUnmounted(() => {
  if (refreshInterval.value) clearInterval(refreshInterval.value);
});
</script>

<template>
  <div class="min-h-screen">
    <!-- Nav -->
    <nav class="border-b border-zinc-800 px-4 py-3 sm:px-6">
      <div class="flex items-center gap-4">
        <NuxtLink
          to="/"
          class="text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200"
        >
          ← Board
        </NuxtLink>
        <span class="text-zinc-700">│</span>
        <span class="text-sm font-semibold text-zinc-200">Card #{{ cardId }}</span>
      </div>
    </nav>

    <div v-if="card" class="flex flex-col lg:flex-row">
      <!-- Card info (top on mobile, left on desktop) -->
      <div class="w-full border-b border-zinc-800 p-4 sm:p-6 lg:w-1/3 lg:border-b-0 lg:border-r">
        <h1 class="mb-2 text-lg font-bold text-zinc-100">{{ card.title }}</h1>

        <div class="mb-4 flex flex-wrap items-center gap-2">
          <SharedStatusBadge :status="card.status as CardStatus" />
          <span
            class="rounded bg-zinc-800 px-2 py-0.5 text-[10px] font-mono uppercase text-zinc-400"
          >
            {{ COLUMN_LABELS[card.column] }}
          </span>
          <span class="text-[10px] font-mono text-zinc-500">
            {{ card.executionMode }}
          </span>
        </div>

        <p v-if="card.description" class="mb-4 text-sm leading-relaxed text-zinc-400">
          {{ card.description }}
        </p>

        <div v-if="card.repo" class="mb-4">
          <SharedRepoBadge :name="card.repo.name" :org="card.repo.org" />
        </div>

        <div v-if="card.githubIssueNumber" class="mb-4 text-xs font-mono text-zinc-500">
          Issue #{{ card.githubIssueNumber }}
          <span v-if="card.githubPrNumber"> · PR #{{ card.githubPrNumber }}</span>
        </div>

        <!-- Agent question input — prominent on mobile -->
        <div
          v-if="card.status === 'waiting_input'"
          class="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
        >
          <p class="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-400">
            Agent needs input
          </p>
          <div class="flex gap-2">
            <input
              v-model="agentInput"
              type="text"
              placeholder="Type your response..."
              class="flex-1 rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 focus:border-amber-500 focus:outline-none"
              @keyup.enter="sendResponse"
            />
            <button
              class="rounded bg-amber-500 px-3 py-2 text-xs font-semibold text-zinc-900 transition-colors hover:bg-amber-400"
              @click="sendResponse"
            >
              Send
            </button>
          </div>
        </div>
      </div>

      <!-- Terminal panel (below on mobile, right on desktop) -->
      <div class="flex-1 p-4 sm:p-6">
        <div class="rounded-lg border border-zinc-800 bg-black p-4">
          <div class="mb-2 flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="h-2 w-2 rounded-full" :class="terminalExists ? 'bg-emerald-500' : 'bg-zinc-600'" />
              <span class="h-2 w-2 rounded-full bg-amber-500" />
              <span class="h-2 w-2 rounded-full bg-red-500" />
              <span class="ml-2 text-[10px] font-mono text-zinc-500">card-{{ cardId }}</span>
            </div>
            <span v-if="terminalExists" class="text-[10px] font-mono text-emerald-500">SESSION ACTIVE</span>
            <span v-else class="text-[10px] font-mono text-zinc-600">NO SESSION</span>
          </div>
          <pre
            v-if="terminalOutput"
            class="max-h-[calc(100vh-200px)] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-zinc-300"
          >{{ terminalOutput }}</pre>
          <p v-else class="py-8 text-center text-zinc-600 text-xs">
            {{ terminalExists ? 'Waiting for output...' : 'No tmux session found for this card.' }}
          </p>
        </div>
      </div>
    </div>

    <div v-else class="flex items-center justify-center py-20">
      <span
        class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-blue-400"
      />
    </div>
  </div>
</template>
