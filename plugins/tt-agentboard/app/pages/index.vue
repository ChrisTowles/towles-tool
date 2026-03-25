<script setup lang="ts">
import type { Card } from "~/composables/useCards";

const selectedCardId = ref<number | null>(null);
const selectedCard = ref<Card | null>(null);
const selectedCardLoading = ref(false);
const showNewCardForm = ref(false);
const newCardPrefill = ref("");

// Voice / Dictation
const {
  isListening,
  transcript,
  interimTranscript,
  isSupported,
  currentContext,
  setContext,
  toggleListening,
  stopListening,
  cancelDictation,
} = useVoice();

// Compute context label for the DictationBar
const dictationContextLabel = computed(() => {
  if (currentContext.value === "card-response" && selectedCard.value) {
    return `Responding to Card #${selectedCardId.value}`;
  }
  if (currentContext.value === "new-card") {
    return "New Card";
  }
  return "Ready";
});

// Auto-detect context when dictation starts
function handleToggleDictation() {
  if (isListening.value) {
    stopListening();
    return;
  }

  // Determine context
  if (selectedCard.value?.status === "waiting_input") {
    setContext("card-response");
  } else if (showNewCardForm.value) {
    setContext("new-card");
  } else {
    setContext("idle");
  }

  toggleListening();
}

// When transcript is finalized and user stops dictation, route it
watch(isListening, async (listening) => {
  if (listening) return;
  const text = transcript.value.trim();
  if (!text) return;

  if (currentContext.value === "card-response" && selectedCardId.value) {
    await $fetch(`/api/agents/${selectedCardId.value}/respond`, {
      method: "POST",
      body: { response: text },
    });
  } else if (currentContext.value === "new-card") {
    // Form is already open, prefill handled by watcher below
  } else {
    // idle: open new card form with transcript as title
    newCardPrefill.value = text;
    showNewCardForm.value = true;
  }

  setContext("idle");
});

const activeTab = ref<"terminal" | "diff">("terminal");
const boardRefreshKey = ref(0);
function refreshBoard() {
  boardRefreshKey.value++;
}

// Card selection
function selectCard(cardId: number) {
  selectedCardId.value = cardId;
  selectedCard.value = null;
  selectedCardLoading.value = true;
  activeTab.value = "terminal";
  fetchSelectedCard().then(() => {
    selectedCardLoading.value = false;
    if (selectedCard.value?.status === "review_ready") {
      activeTab.value = "diff";
    }
  });
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
  refreshBoard();
}

async function startCard() {
  if (!selectedCardId.value) return;
  await $fetch(`/api/cards/${selectedCardId.value}/move`, {
    method: "POST",
    body: { column: "in_progress", position: 0 },
  });
  await fetchSelectedCard();
  refreshBoard();
}

async function retryCard() {
  if (!selectedCardId.value) return;
  await $fetch(`/api/cards/${selectedCardId.value}/move`, {
    method: "POST",
    body: { column: "in_progress" },
  });
  await fetchSelectedCard();
  refreshBoard();
}

async function fetchSelectedCard() {
  if (!selectedCardId.value) return;
  try {
    selectedCard.value = await $fetch<Card>(`/api/cards/${selectedCardId.value}`);
  } catch {
    selectedCard.value = null;
  }
}

function onCardCreated() {
  showNewCardForm.value = false;
  newCardPrefill.value = "";
}

// Refresh selected card periodically (client-only)
const detailInterval = ref<ReturnType<typeof setInterval> | null>(null);
onMounted(() => {
  watch(selectedCardId, (id) => {
    if (detailInterval.value) clearInterval(detailInterval.value);
    if (id) {
      detailInterval.value = setInterval(fetchSelectedCard, 2000);
    }
  });
});
onUnmounted(() => {
  if (detailInterval.value) clearInterval(detailInterval.value);
});

// Keyboard shortcuts
useKeyboardShortcuts({
  newCard: () => {
    showNewCardForm.value = true;
  },
  refresh: () => {
    // Trigger board refresh via a custom event or direct fetch
  },
  closePanel: () => {
    if (selectedCardId.value) closePanel();
  },
  dictate: () => {
    handleToggleDictation();
  },
  archive: () => {
    if (selectedCard.value?.status === "review_ready") archiveCard();
  },
  retry: () => {
    if (selectedCard.value?.status === "failed") retryCard();
  },
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
        <BoardKanbanBoard
          :is-dictating="isListening"
          :show-new-card="showNewCardForm"
          :new-card-prefill="newCardPrefill"
          :refresh-trigger="boardRefreshKey"
          @card-selected="selectCard"
          @toggle-dictation="handleToggleDictation"
          @new-card-closed="
            showNewCardForm = false;
            newCardPrefill = '';
          "
        />
      </div>

      <!-- Detail Panel (right half, slides in) -->
      <Transition name="slide">
        <div v-if="selectedCardId" class="flex w-1/2 flex-col border-l border-zinc-800 bg-zinc-950">
          <!-- Panel header -->
          <div class="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
            <span class="text-sm font-semibold text-zinc-200">Card #{{ selectedCardId }}</span>
            <div class="flex items-center gap-2">
              <button
                v-if="
                  selectedCard &&
                  (selectedCard.status === 'idle' || selectedCard.status === 'queued')
                "
                class="rounded-lg bg-blue-600 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-blue-500"
                @click="startCard"
              >
                Start Agent
              </button>
              <button
                v-if="selectedCard?.status === 'failed'"
                class="rounded-lg bg-amber-600 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-amber-500"
                @click="retryCard"
              >
                Retry
              </button>
              <button
                v-if="selectedCard?.status === 'review_ready'"
                class="rounded-lg bg-amber-600 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-amber-500"
                @click="retryCard"
              >
                Rerun
              </button>
              <button
                v-if="selectedCard?.status === 'review_ready'"
                class="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-emerald-500"
                @click="archiveCard"
              >
                Archive
              </button>
              <CardActions
                v-if="selectedCard"
                :card="selectedCard"
                @archive="archiveCard"
                @retry="retryCard"
                @start="startCard"
              />
              <NuxtLink
                :to="`/cards/${selectedCardId}`"
                class="rounded px-2 py-1 text-[10px] font-medium text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
              >
                Open full ↗
              </NuxtLink>
              <button
                class="rounded px-2 py-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                title="Close panel (Esc)"
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
            <CardDetail :card="selectedCard" compact @archive="archiveCard" />
          </div>

          <!-- Tab bar -->
          <div v-if="selectedCard" class="flex border-b border-zinc-800">
            <button
              class="px-4 py-2 text-xs font-medium transition-colors"
              :class="
                activeTab === 'terminal'
                  ? 'border-b-2 border-blue-500 text-zinc-200'
                  : 'text-zinc-500 hover:text-zinc-300'
              "
              @click="activeTab = 'terminal'"
            >
              Terminal
            </button>
            <button
              class="px-4 py-2 text-xs font-medium transition-colors"
              :class="
                activeTab === 'diff'
                  ? 'border-b-2 border-violet-500 text-zinc-200'
                  : 'text-zinc-500 hover:text-zinc-300'
              "
              @click="activeTab = 'diff'"
            >
              Diff
            </button>
          </div>

          <!-- Tab content -->
          <div v-if="selectedCard" class="flex-1 overflow-hidden p-3">
            <ClientOnly>
              <CardTerminalPanel v-if="activeTab === 'terminal'" :card-id="selectedCardId!" />
              <CardDiffViewer v-else :card-id="selectedCardId!" />
            </ClientOnly>
          </div>
        </div>
      </Transition>
    </div>

    <!-- Dictation Bar -->
    <ClientOnly>
      <SharedDictationBar
        :is-listening="isListening"
        :interim-transcript="interimTranscript"
        :transcript="transcript"
        :current-context="currentContext"
        :context-label="dictationContextLabel"
        @cancel="cancelDictation"
        @stop="stopListening"
      />
    </ClientOnly>
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
