<script setup lang="ts">
import type { Card } from "~/composables/useCards";

const selectedCardId = ref<number | null>(null);
const selectedCard = ref<Card | null>(null);
const selectedCardLoading = ref(false);

async function selectCard(cardId: number) {
  selectedCardId.value = cardId;
  selectedCardLoading.value = true;
  await fetchSelectedCard();
  selectedCardLoading.value = false;
}

function closePanel() {
  selectedCardId.value = null;
  selectedCard.value = null;
}

async function archiveCard() {
  if (!selectedCardId.value) return;
  await $fetch(`/api/cards/${selectedCardId.value}/move`, {
    method: "POST",
    body: { column: "done" },
  });
  closePanel();
}

async function fetchSelectedCard() {
  if (!selectedCardId.value) return;
  try {
    selectedCard.value = await $fetch<Card>(`/api/cards/${selectedCardId.value}`);
  } catch {
    selectedCard.value = null;
  }
}

// Refresh selected card periodically
const detailInterval = ref<ReturnType<typeof setInterval> | null>(null);
watch(selectedCardId, (id) => {
  if (detailInterval.value) clearInterval(detailInterval.value);
  if (id) {
    detailInterval.value = setInterval(fetchSelectedCard, 2000);
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
            <span class="text-sm font-semibold text-zinc-200">Card #{{ selectedCardId }}</span>
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
          <div v-if="selectedCard" class="border-b border-zinc-800 px-4 py-3">
            <CardCardDetail :card="selectedCard" compact @archive="archiveCard" />
          </div>

          <!-- Terminal panel (xterm.js) -->
          <div v-if="selectedCard" class="flex-1 overflow-hidden p-3">
            <ClientOnly>
              <CardTerminalPanel :card-id="selectedCardId!" />
            </ClientOnly>
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
