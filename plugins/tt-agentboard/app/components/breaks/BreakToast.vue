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

const snoozeLabel = computed(() =>
  store.hasSnoozedCurrent ? "Dismiss" : `Snooze ${store.config.snoozeDurationMinutes}m`,
);
</script>

<template>
  <Transition name="toast">
    <div
      v-if="store.showToast"
      class="fixed bottom-20 right-6 z-50 flex w-80 flex-col gap-3 rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-2xl shadow-black/40"
    >
      <div class="flex items-start gap-3">
        <span class="text-2xl">{{ icon }}</span>
        <div class="flex-1">
          <p class="text-sm font-semibold text-zinc-100">Time for a break</p>
          <p class="mt-1 text-sm text-zinc-400">{{ store.currentPrompt }}</p>
        </div>
      </div>
      <div class="flex gap-2">
        <button
          class="flex-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-500"
          @click="store.completeBreak()"
        >
          Done
        </button>
        <button
          class="flex-1 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
          @click="store.snoozeBreak()"
        >
          {{ snoozeLabel }}
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s ease;
}
.toast-enter-from,
.toast-leave-to {
  transform: translateX(100%);
  opacity: 0;
}
</style>
