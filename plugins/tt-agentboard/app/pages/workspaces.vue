<script setup lang="ts">
const { data: repos, refresh: refreshRepos } = useFetch<{ id: number }[]>("/api/repos");
const { data: slots, refresh: refreshSlots } = useFetch<{ id: number }[]>("/api/slots");

const showOnboarding = computed(() => !repos.value?.length && !slots.value?.length);

async function onOnboardingComplete() {
  await Promise.all([refreshRepos(), refreshSlots()]);
}
</script>

<template>
  <div class="min-h-screen">
    <!-- Nav -->
    <nav class="border-b border-zinc-800 px-6 py-3">
      <div class="flex items-center gap-4">
        <NuxtLink
          to="/"
          class="text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200"
        >
          ← Board
        </NuxtLink>
        <span class="text-zinc-700">|</span>
        <span class="text-sm font-semibold text-zinc-200">Workspaces</span>
      </div>
    </nav>

    <div class="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <div v-if="showOnboarding">
        <WorkspaceOnboardingWizard @complete="onOnboardingComplete" />
      </div>
      <WorkspaceSlotRegistry v-else />
    </div>
  </div>
</template>
