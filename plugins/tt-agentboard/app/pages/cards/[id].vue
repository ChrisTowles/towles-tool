<script setup lang="ts">
import type { Card } from "~/composables/useCards";

const route = useRoute();
const cardId = computed(() => Number(route.params.id));

const { data: card, refresh } = await useFetch<Card>(`/api/cards/${cardId.value}`);

const router = useRouter();
const activeTab = ref<"terminal" | "diff">("terminal");

// Default to diff tab for review_ready cards
watch(
  () => card.value?.status,
  (status) => {
    if (status === "review_ready") activeTab.value = "diff";
  },
  { immediate: true },
);

async function archiveCard() {
  await $fetch(`/api/cards/${cardId.value}/move`, {
    method: "POST",
    body: { column: "done" },
  });
  router.push("/");
}

async function startCard() {
  await $fetch(`/api/cards/${cardId.value}/move`, {
    method: "POST",
    body: { column: "in_progress", position: 0 },
  });
  await refresh();
}

async function retryCard() {
  await $fetch(`/api/cards/${cardId.value}/move`, {
    method: "POST",
    body: { column: "in_progress" },
  });
  await refresh();
}

async function sendAgentResponse(response: string) {
  await $fetch(`/api/agents/${cardId.value}/respond`, {
    method: "POST",
    body: { response },
  }).catch(() => {});
}

const refreshInterval = ref<ReturnType<typeof setInterval> | null>(null);
onMounted(() => {
  refreshInterval.value = setInterval(refresh, 2000);
});
onUnmounted(() => {
  if (refreshInterval.value) clearInterval(refreshInterval.value);
});
</script>

<template>
  <div class="min-h-screen">
    <!-- Nav -->
    <nav class="border-b border-zinc-800 px-4 py-3 sm:px-6">
      <div class="flex items-center justify-between">
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
        <CardActions v-if="card" :card="card" @archive="archiveCard" @retry="retryCard" @start="startCard" />
      </div>
    </nav>

    <div v-if="card" class="flex flex-col lg:flex-row">
      <!-- Card info (top on mobile, left on desktop) -->
      <div class="w-full border-b border-zinc-800 p-4 sm:p-6 lg:w-1/3 lg:border-b-0 lg:border-r">
        <CardDetail :card="card" @archive="archiveCard" @respond="sendAgentResponse" />
      </div>

      <!-- Tab bar + content (below on mobile, right on desktop) -->
      <div class="flex flex-1 flex-col" style="min-height: calc(100vh - 200px)">
        <div class="flex border-b border-zinc-800">
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
        <div class="flex-1 p-4 sm:p-6">
          <ClientOnly>
            <CardTerminalPanel v-if="activeTab === 'terminal'" :card-id="cardId" />
            <CardDiffViewer v-else :card-id="cardId" />
          </ClientOnly>
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
