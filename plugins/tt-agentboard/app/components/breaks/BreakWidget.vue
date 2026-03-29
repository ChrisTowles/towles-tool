<script setup lang="ts">
const store = useBreakReminderStore();

const showSettings = ref(false);
const now = useNow({ interval: 1000 });

const progressFraction = computed(() => {
  const total = store.todayStats.completed + store.todayStats.skipped;
  const expected = store.expectedBreaksToday;
  if (expected === 0) return 0;
  return Math.min(1, total / expected);
});

const progressPercent = computed(() => Math.round(progressFraction.value * 100));

function formatCountdown(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const statusLabel = computed(() => {
  if (store.isPaused) return "Paused";
  if (store.isInFocusMode) {
    const remainingSec = Math.max(
      0,
      Math.round(((store.focusModeUntil ?? 0) - now.value.getTime()) / 1000),
    );
    return `Focus ${formatCountdown(remainingSec)}`;
  }
  if (!store.lastBreakTimestamp) return "--:--";
  const elapsedSec = Math.round((now.value.getTime() - store.lastBreakTimestamp) / 1000);
  const intervalSec = store.config.intervalMinutes * 60;
  const remainingSec = Math.max(0, intervalSec - elapsedSec);
  if (remainingSec === 0) return "Due now";
  return formatCountdown(remainingSec);
});
</script>

<template>
  <div class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
    <div class="mb-2 flex items-center justify-between">
      <span class="text-xs font-semibold text-zinc-400">Breaks</span>
      <button
        class="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
        title="Break settings"
        @click="showSettings = !showSettings"
      >
        <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
          />
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
      </button>
    </div>

    <!-- Progress bar -->
    <div class="mb-2 h-1.5 rounded-full bg-zinc-800">
      <div
        class="h-full rounded-full bg-emerald-500 transition-all duration-500"
        :style="{ width: `${progressPercent}%` }"
      />
    </div>

    <!-- Stats row -->
    <div class="flex items-center justify-between text-[11px]">
      <span class="text-zinc-400">
        {{ store.todayStats.completed }} / {{ store.expectedBreaksToday }} taken
      </span>
      <span class="font-mono text-zinc-500">{{ statusLabel }}</span>
    </div>

    <!-- Quick actions -->
    <div class="mt-2 flex gap-1">
      <button
        class="rounded px-2 py-0.5 text-[10px] font-medium transition-colors"
        :class="
          store.isPaused
            ? 'bg-blue-600 text-white'
            : 'border border-zinc-700 text-zinc-400 hover:bg-zinc-800'
        "
        @click="store.togglePause()"
      >
        {{ store.isPaused ? "Resume" : "Pause" }}
      </button>
      <button
        v-if="!store.isInFocusMode"
        class="rounded border border-zinc-700 px-2 py-0.5 text-[10px] font-medium text-zinc-400 transition-colors hover:bg-zinc-800"
        @click="store.enableFocusMode(30)"
      >
        Focus 30m
      </button>
      <button
        v-if="!store.isInFocusMode"
        class="rounded border border-zinc-700 px-2 py-0.5 text-[10px] font-medium text-zinc-400 transition-colors hover:bg-zinc-800"
        @click="store.enableFocusMode(60)"
      >
        Focus 60m
      </button>
      <button
        v-if="store.isInFocusMode"
        class="rounded border border-amber-700 px-2 py-0.5 text-[10px] font-medium text-amber-400 transition-colors hover:bg-amber-950"
        @click="store.disableFocusMode()"
      >
        End focus
      </button>
    </div>

    <!-- Settings panel -->
    <BreaksBreakSettings v-if="showSettings" class="mt-3" @close="showSettings = false" />
  </div>
</template>
