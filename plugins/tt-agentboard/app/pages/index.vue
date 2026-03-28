<script setup lang="ts">
import type { Card } from "~/stores/cards";

const breakStore = useBreakReminderStore();

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
  // When NewCardForm is open, VoiceInput handles transcription directly
  if (showNewCardForm.value) return;

  const text = transcript.value.trim();
  if (!text) return;

  if (currentContext.value === "card-response" && selectedCardId.value) {
    await $fetch(`/api/agents/${selectedCardId.value}/respond`, {
      method: "POST",
      body: { response: text },
    });
  } else {
    // idle: open new card form with transcript as title
    newCardPrefill.value = text;
    showNewCardForm.value = true;
  }

  setContext("idle");
});

const activeTab = ref<"terminal" | "diff" | "events" | "activity">("activity");
const cardEvents = ref<{ id: number; event: string; detail: string | null; timestamp: string }[]>(
  [],
);

async function fetchCardEvents() {
  if (!selectedCardId.value) return;
  try {
    cardEvents.value = await $fetch(`/api/cards/${selectedCardId.value}/events`);
  } catch {
    cardEvents.value = [];
  }
}
const boardRefreshKey = ref(0);
function refreshBoard() {
  boardRefreshKey.value++;
}

// Card selection
function selectCard(cardId: number) {
  selectedCardId.value = cardId;
  selectedCard.value = null;
  selectedCardLoading.value = true;
  activeTab.value = "activity";
  fetchSelectedCard().then(() => {
    selectedCardLoading.value = false;
    fetchCardEvents();
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

async function createPR() {
  if (!selectedCardId.value) return;
  try {
    const result = await $fetch<{ prNumber: number; prUrl: string }>(
      `/api/agents/${selectedCardId.value}/create-pr`,
      { method: "POST" },
    );
    await fetchSelectedCard();
    refreshBoard();
  } catch {
    // TODO: show error toast
  }
}

async function deleteCard() {
  if (!selectedCardId.value) return;
  await $fetch(`/api/cards/${selectedCardId.value}`, { method: "DELETE" });
  closePanel();
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

// Break reminders — start timer and track input
onMounted(() => {
  breakStore.start();

  const handleInput = () => breakStore.recordInput();
  document.addEventListener("mousemove", handleInput, { passive: true });
  document.addEventListener("keydown", handleInput, { passive: true });

  // Throttle: only update once per 10 seconds
  let lastRecorded = 0;
  const throttledInput = () => {
    const now = Date.now();
    if (now - lastRecorded > 10_000) {
      lastRecorded = now;
      breakStore.recordInput();
    }
  };
  document.removeEventListener("mousemove", handleInput);
  document.removeEventListener("keydown", handleInput);
  document.addEventListener("mousemove", throttledInput, { passive: true });
  document.addEventListener("keydown", throttledInput, { passive: true });
});
onUnmounted(() => {
  breakStore.stop();
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
    <!-- Break reminder overlays -->
    <ClientOnly>
      <BreaksBreakBanner />
      <BreaksBreakToast />
    </ClientOnly>

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
                v-if="
                  selectedCard?.status === 'review_ready' &&
                  !selectedCard?.githubPrNumber &&
                  selectedCard?.branch
                "
                class="rounded-lg bg-violet-600 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-violet-500"
                @click="createPR"
              >
                Create PR
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
              <button
                v-if="selectedCard"
                class="rounded-lg border border-red-800 px-3 py-1 text-xs font-medium text-red-400 transition-colors hover:bg-red-950"
                @click="deleteCard"
              >
                Delete
              </button>
              <CardActions
                v-if="selectedCard"
                :card="selectedCard"
                @archive="archiveCard"
                @retry="retryCard"
                @start="startCard"
                @deleted="
                  closePanel();
                  refreshBoard();
                "
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
            <button
              class="px-4 py-2 text-xs font-medium transition-colors"
              :class="
                activeTab === 'activity'
                  ? 'border-b-2 border-emerald-500 text-zinc-200'
                  : 'text-zinc-500 hover:text-zinc-300'
              "
              @click="activeTab = 'activity'"
            >
              Activity
            </button>
            <button
              class="px-4 py-2 text-xs font-medium transition-colors"
              :class="
                activeTab === 'events'
                  ? 'border-b-2 border-amber-500 text-zinc-200'
                  : 'text-zinc-500 hover:text-zinc-300'
              "
              @click="
                activeTab = 'events';
                fetchCardEvents();
              "
            >
              Events
            </button>
          </div>

          <!-- Tab content -->
          <div v-if="selectedCard" class="flex-1 overflow-hidden p-3">
            <ClientOnly>
              <CardActivityPanel v-if="activeTab === 'activity'" :card-id="selectedCardId!" />
              <CardTerminalPanel v-else-if="activeTab === 'terminal'" :card-id="selectedCardId!" />
              <CardDiffViewer v-else-if="activeTab === 'diff'" :card-id="selectedCardId!" />
            </ClientOnly>

            <!-- Events log -->
            <div
              v-if="activeTab === 'events'"
              class="h-full overflow-auto rounded-lg border border-zinc-800 bg-black p-3"
            >
              <div v-if="cardEvents.length === 0" class="py-8 text-center text-xs text-zinc-600">
                No events recorded yet
              </div>
              <div v-else class="space-y-1">
                <div
                  v-for="evt in cardEvents"
                  :key="evt.id"
                  class="flex items-start gap-3 rounded px-2 py-1.5 text-[11px] hover:bg-zinc-900"
                >
                  <span class="shrink-0 font-mono text-zinc-600">
                    {{ new Date(evt.timestamp).toLocaleTimeString() }}
                  </span>
                  <span
                    class="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold"
                    :class="{
                      'bg-blue-500/10 text-blue-400': evt.event.includes('start'),
                      'bg-emerald-500/10 text-emerald-400':
                        evt.event.includes('complete') || evt.event.includes('hook_received'),
                      'bg-red-500/10 text-red-400':
                        evt.event.includes('error') || evt.event.includes('fail'),
                      'bg-amber-500/10 text-amber-400':
                        evt.event.includes('queued') || evt.event.includes('ignored'),
                      'bg-zinc-800 text-zinc-400':
                        !evt.event.includes('start') &&
                        !evt.event.includes('complete') &&
                        !evt.event.includes('error') &&
                        !evt.event.includes('queued'),
                    }"
                  >
                    {{ evt.event }}
                  </span>
                  <span v-if="evt.detail" class="text-zinc-500">{{ evt.detail }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </div>

    <!-- Dictation Bar — hidden when NewCardForm is open (it has its own VoiceInput) -->
    <ClientOnly>
      <SharedDictationBar
        v-if="!showNewCardForm"
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
