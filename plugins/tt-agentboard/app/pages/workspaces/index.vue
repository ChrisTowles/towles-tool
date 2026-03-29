<script setup lang="ts">
import type { Slot } from "~/components/workspace/SlotCard.vue";

const { data: repos } = useFetch<{ id: number }[]>("/api/repos");
const { data: slots } = useFetch<Slot[]>("/api/slots");

const needsSetup = computed(() => !repos.value?.length && !slots.value?.length);

interface SlotHealth {
  slotId: number;
  dirty: boolean;
  isStale: boolean;
}

const slotHealth = ref<Map<number, SlotHealth>>(new Map());

async function fetchAllHealth() {
  if (!slots.value) return;
  const results = await Promise.allSettled(
    slots.value.map(async (s) => {
      const info = await $fetch<{ dirty: boolean | null; isStale: boolean }>(
        `/api/slots/${s.id}/git-info`,
      );
      return { slotId: s.id, dirty: info.dirty === true, isStale: info.isStale };
    }),
  );
  const map = new Map<number, SlotHealth>();
  for (const r of results) {
    if (r.status === "fulfilled") map.set(r.value.slotId, r.value);
  }
  slotHealth.value = map;
}

watch(slots, () => fetchAllHealth(), { immediate: true });

const summary = computed(() => {
  if (!slots.value) return null;
  const total = slots.value.length;
  const available = slots.value.filter((s) => s.status === "available").length;
  let stale = 0;
  let dirty = 0;
  for (const h of slotHealth.value.values()) {
    if (h.isStale) stale++;
    if (h.dirty) dirty++;
  }
  return { total, available, stale, dirty };
});
</script>

<template>
  <div class="mx-auto max-w-5xl px-4 py-8 sm:px-6">
    <div class="mb-6 flex items-center justify-between">
      <div class="flex items-center gap-4">
        <NuxtLink to="/" class="text-xs text-zinc-500 transition-colors hover:text-zinc-300">
          &larr; Board
        </NuxtLink>
        <h1 class="text-xl font-bold text-zinc-100">Workspaces</h1>
      </div>
      <NuxtLink
        to="/workspaces/setup"
        class="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-500"
      >
        Setup Wizard
      </NuxtLink>
    </div>

    <!-- Health summary bar -->
    <div
      v-if="summary && summary.total > 0"
      class="mb-4 flex items-center gap-4 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-2 text-xs font-mono"
    >
      <span class="text-zinc-400"> {{ summary.available }}/{{ summary.total }} available </span>
      <span v-if="summary.stale > 0" class="text-amber-400"> {{ summary.stale }} stale </span>
      <span v-if="summary.dirty > 0" class="text-red-400"> {{ summary.dirty }} dirty </span>
      <span v-if="summary.stale === 0 && summary.dirty === 0" class="text-emerald-400">
        All healthy
      </span>
    </div>

    <div v-if="!needsSetup" class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
      <WorkspaceSlotRegistry />
    </div>

    <div v-else class="flex flex-col items-center py-16 text-center">
      <p class="mb-2 text-sm font-semibold text-zinc-300">No workspaces configured</p>
      <p class="mb-4 text-xs text-zinc-500">Run the setup wizard to add repos and slots.</p>
      <NuxtLink
        to="/workspaces/setup"
        class="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500"
      >
        Run Setup Wizard
      </NuxtLink>
    </div>
  </div>
</template>
