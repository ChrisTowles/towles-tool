<script setup lang="ts">
import type { Card } from "~/composables/useCards";
import type { CardStatus } from "~/utils/constants";
import { COLUMN_LABELS } from "~/utils/constants";

const selectedCardId = ref<number | null>(null);
const selectedCard = ref<Card | null>(null);
const selectedCardLoading = ref(false);
const terminalOutput = ref("");
const terminalExists = ref(false);

async function selectCard(cardId: number) {
  selectedCardId.value = cardId;
  selectedCardLoading.value = true;
  await Promise.all([fetchSelectedCard(), fetchTerminal()]);
  selectedCardLoading.value = false;
}

function closePanel() {
  selectedCardId.value = null;
  selectedCard.value = null;
  terminalOutput.value = "";
  terminalExists.value = false;
}

async function fetchSelectedCard() {
  if (!selectedCardId.value) return;
  try {
    selectedCard.value = await $fetch<Card>(`/api/cards/${selectedCardId.value}`);
  } catch {
    selectedCard.value = null;
  }
}

async function fetchTerminal() {
  if (!selectedCardId.value) return;
  try {
    const data = await $fetch<{ exists: boolean; output: string }>(
      `/api/agents/${selectedCardId.value}/terminal`,
    );
    terminalExists.value = data.exists;
    terminalOutput.value = data.output;
  } catch {
    terminalExists.value = false;
  }
}

// Refresh selected card + terminal periodically
const detailInterval = ref<ReturnType<typeof setInterval> | null>(null);
watch(selectedCardId, (id) => {
  if (detailInterval.value) clearInterval(detailInterval.value);
  if (id) {
    detailInterval.value = setInterval(() => {
      fetchSelectedCard();
      fetchTerminal();
    }, 2000);
  }
});
onUnmounted(() => {
  if (detailInterval.value) clearInterval(detailInterval.value);
});
</script>

<template>
  <div class="flex h-screen flex-col">
    <!-- Split: Board + Detail Panel -->
    <div class="flex flex-1 overflow-hidden">
      <!-- Board (full width when no card selected, left half when selected) -->
      <div
        class="flex-1 overflow-hidden transition-all duration-300"
        :class="selectedCardId ? 'w-1/2' : 'w-full'"
      >
        <BoardKanbanBoard @card-selected="selectCard" />
      </div>

      <!-- Detail Panel (right half, slides in) -->
      <Transition name="slide">
        <div v-if="selectedCardId" class="flex w-1/2 flex-col border-l border-zinc-800 bg-zinc-950">
          <!-- Panel header -->
          <div class="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
            <div class="flex items-center gap-3">
              <span class="text-sm font-semibold text-zinc-200">Card #{{ selectedCardId }}</span>
              <SharedStatusBadge v-if="selectedCard" :status="selectedCard.status as CardStatus" />
              <span
                v-if="selectedCard"
                class="rounded bg-zinc-800 px-2 py-0.5 text-[10px] font-mono uppercase text-zinc-400"
              >
                {{ COLUMN_LABELS[selectedCard.column] }}
              </span>
            </div>
            <div class="flex items-center gap-2">
              <NuxtLink
                :to="`/cards/${selectedCardId}`"
                class="rounded px-2 py-1 text-[10px] font-medium text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
              >
                Open full ↗
              </NuxtLink>
              <button
                class="rounded px-2 py-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                @click="closePanel"
              >
                ✕
              </button>
            </div>
          </div>

          <!-- Loading state -->
          <div
            v-if="selectedCardLoading && !selectedCard"
            class="flex flex-1 items-center justify-center"
          >
            <span
              class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-blue-400"
            />
          </div>

          <!-- Card info -->
          <template v-if="selectedCard">
            <div class="border-b border-zinc-800 px-4 py-3">
              <h2 class="mb-1 text-sm font-bold text-zinc-100">{{ selectedCard.title }}</h2>
              <p
                v-if="selectedCard.description"
                class="text-xs leading-relaxed text-zinc-400 line-clamp-3"
              >
                {{ selectedCard.description }}
              </p>
            </div>
          </template>

          <!-- Terminal output -->
          <div v-if="selectedCard" class="flex-1 overflow-hidden p-3">
            <div class="flex h-full flex-col rounded-lg border border-zinc-800 bg-black">
              <div class="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
                <div class="flex items-center gap-2">
                  <span
                    class="h-2 w-2 rounded-full"
                    :class="terminalExists ? 'bg-emerald-500' : 'bg-zinc-600'"
                  />
                  <span class="text-[10px] font-mono text-zinc-500">
                    card-{{ selectedCardId }}
                  </span>
                </div>
                <span v-if="terminalExists" class="text-[10px] font-mono text-emerald-500">
                  SESSION ACTIVE
                </span>
                <span v-else class="text-[10px] font-mono text-zinc-600">NO SESSION</span>
              </div>
              <div class="flex-1 overflow-auto p-3">
                <pre
                  v-if="terminalOutput"
                  class="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-zinc-300"
                  >{{ terminalOutput }}</pre
                >
                <p v-else class="py-8 text-center text-xs text-zinc-600">
                  {{ terminalExists ? "Waiting for output..." : "No tmux session for this card." }}
                </p>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.slide-enter-active,
.slide-leave-active {
  transition: all 0.2s ease;
}
.slide-enter-from,
.slide-leave-to {
  transform: translateX(100%);
  opacity: 0;
}
</style>
