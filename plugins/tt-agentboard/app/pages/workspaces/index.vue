<script setup lang="ts">
const { data: repos } = useFetch<{ id: number }[]>("/api/repos");
const { data: slots } = useFetch<{ id: number }[]>("/api/slots");

const needsSetup = computed(() => !repos.value?.length && !slots.value?.length);
</script>

<template>
  <div class="min-h-screen">
    <nav class="border-b border-zinc-800 px-6 py-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-4">
          <NuxtLink
            to="/"
            class="text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200"
          >
            ← Board
          </NuxtLink>
          <span class="text-zinc-700">│</span>
          <span class="text-sm font-semibold text-zinc-200">Workspaces</span>
        </div>
        <NuxtLink
          to="/workspaces/setup"
          class="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-700"
        >
          Scan for Repos
        </NuxtLink>
      </div>
    </nav>

    <div class="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <div
        v-if="needsSetup"
        class="flex flex-col items-center justify-center rounded-lg border border-dashed border-zinc-800 py-16 text-center"
      >
        <p class="mb-2 text-sm font-semibold text-zinc-300">No workspaces configured</p>
        <p class="mb-4 text-xs text-zinc-500">
          Set up your repo scan paths and register workspace slots to start running agents.
        </p>
        <NuxtLink
          to="/workspaces/setup"
          class="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500"
        >
          Run Setup Wizard
        </NuxtLink>
      </div>

      <WorkspaceSlotRegistry v-else />
    </div>
  </div>
</template>
