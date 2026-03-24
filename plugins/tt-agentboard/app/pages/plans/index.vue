<script setup lang="ts">
interface Plan {
  id: number;
  name: string;
  description: string | null;
  prGranularity: string;
}

const { data: plans, status } = useFetch<Plan[]>("/api/plans");
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
        <span class="text-sm font-semibold text-zinc-200">Plans</span>
      </div>
    </nav>

    <!-- Loading -->
    <div v-if="status === 'pending'" class="flex items-center justify-center py-20">
      <span
        class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-blue-400"
      />
    </div>

    <!-- Empty state -->
    <div v-else-if="!plans?.length" class="mx-auto max-w-md py-20 text-center">
      <p class="mb-2 text-sm text-zinc-400">No plans yet</p>
      <p class="text-xs leading-relaxed text-zinc-600">
        Plans group related cards into a dependency graph. Create a plan via the API to coordinate
        multi-card workflows.
      </p>
    </div>

    <!-- Plan list -->
    <div v-else class="mx-auto max-w-4xl space-y-3 p-4 sm:p-6">
      <NuxtLink
        v-for="plan in plans"
        :key="plan.id"
        :to="`/plans/${plan.id}`"
        class="block rounded-xl border border-zinc-800 bg-zinc-900/50 px-5 py-4 transition-colors hover:border-zinc-700 hover:bg-zinc-800/50"
      >
        <div class="flex items-center justify-between gap-4">
          <div>
            <h2 class="text-sm font-bold text-zinc-100">{{ plan.name }}</h2>
            <p v-if="plan.description" class="mt-1 text-xs text-zinc-400">
              {{ plan.description }}
            </p>
          </div>
          <span
            class="shrink-0 rounded bg-zinc-800 px-2 py-0.5 text-[10px] font-mono text-zinc-500"
          >
            {{ plan.prGranularity === "per_card" ? "Per Card" : "Per Plan" }}
          </span>
        </div>
      </NuxtLink>
    </div>
  </div>
</template>
