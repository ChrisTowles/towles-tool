<script setup lang="ts">
import type { Card } from "~/composables/useCards";

const route = useRoute();
const cardId = computed(() => Number(route.params.id));

const { data: card, refresh } = await useFetch<Card>(`/api/cards/${cardId.value}`);

const router = useRouter();

async function archiveCard() {
  await $fetch(`/api/cards/${cardId.value}/move`, {
    method: "POST",
    body: { column: "done" },
  });
  router.push("/");
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
        <CardCardDetail
          :card="card"
          @archive="archiveCard"
          @respond="sendAgentResponse"
        />
      </div>

      <!-- Terminal panel (below on mobile, right on desktop) -->
      <div class="flex-1 p-4 sm:p-6" style="min-height: calc(100vh - 200px)">
        <ClientOnly>
          <CardTerminalPanel :card-id="cardId" />
        </ClientOnly>
      </div>
    </div>

    <div v-else class="flex items-center justify-center py-20">
      <span
        class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-blue-400"
      />
    </div>
  </div>
</template>
