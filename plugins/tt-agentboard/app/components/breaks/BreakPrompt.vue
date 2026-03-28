<script setup lang="ts">
const store = useBreakReminderStore();

const BREAK_TYPE_ICONS: Record<string, string> = {
  stairs: "🪜",
  walk: "🚶",
  stretch: "🧘",
  water: "💧",
};

const icon = computed(() =>
  store.currentBreakType ? (BREAK_TYPE_ICONS[store.currentBreakType] ?? "🏃") : "🏃",
);

const isEscalated = computed(() => store.showBanner);

const snoozeLabel = computed(() =>
  store.hasSnoozedCurrent ? "Dismiss" : `Snooze ${store.config.snoozeDurationMinutes}m`,
);

const visible = computed(() => store.showToast || store.showBanner);
</script>

<template>
  <div v-if="visible" class="px-4 py-6 sm:px-6">
    <div
      class="mx-auto flex max-w-lg flex-col items-center rounded-lg border py-10 text-center"
      :class="
        isEscalated
          ? 'border-amber-600/50 bg-amber-950/30 shadow-lg shadow-amber-900/20'
          : 'border-dashed border-emerald-700/50 bg-emerald-950/20'
      "
    >
      <span class="mb-3 text-5xl">{{ icon }}</span>
      <p class="mb-1 text-lg font-bold" :class="isEscalated ? 'text-amber-200' : 'text-zinc-100'">
        {{ isEscalated ? "You really need a break" : "Time for a break" }}
      </p>
      <p v-if="isEscalated" class="mb-2 text-xs text-amber-400/80">
        You've been working for over {{ store.config.escalationThresholdMinutes }} minutes straight
      </p>
      <p class="mb-6 text-sm text-zinc-400">{{ store.currentPrompt }}</p>
      <div class="flex gap-3">
        <button
          class="rounded-lg px-6 py-2 text-sm font-semibold text-white transition-colors"
          :class="
            isEscalated ? 'bg-amber-600 hover:bg-amber-500' : 'bg-emerald-600 hover:bg-emerald-500'
          "
          @click="store.completeBreak()"
        >
          I took a break
        </button>
        <button
          class="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          @click="store.snoozeBreak()"
        >
          {{ snoozeLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
