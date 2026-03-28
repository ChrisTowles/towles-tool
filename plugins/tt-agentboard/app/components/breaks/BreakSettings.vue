<script setup lang="ts">
import { BREAK_TYPES } from "~/stores/breakReminder";
import type { BreakType } from "~/stores/breakReminder";

const emit = defineEmits<{ close: [] }>();
const store = useBreakReminderStore();

const interval = ref(store.config.intervalMinutes);
const soundEnabled = ref(store.config.soundEnabled);
const enabledTypes = ref<Set<BreakType>>(new Set(store.config.enabledBreakTypes));

const BREAK_TYPE_LABELS: Record<BreakType, string> = {
  stairs: "Stairs",
  walk: "Walk",
  stretch: "Stretch",
  water: "Water",
};

function toggleType(t: BreakType) {
  if (enabledTypes.value.has(t)) {
    // Don't allow disabling all types
    if (enabledTypes.value.size > 1) {
      enabledTypes.value.delete(t);
    }
  } else {
    enabledTypes.value.add(t);
  }
}

function save() {
  store.updateConfig({
    intervalMinutes: interval.value,
    soundEnabled: soundEnabled.value,
    enabledBreakTypes: [...enabledTypes.value],
  });
  emit("close");
}
</script>

<template>
  <div class="rounded-lg border border-zinc-700 bg-zinc-800/50 p-3">
    <div class="mb-3 flex items-center justify-between">
      <span class="text-xs font-semibold text-zinc-300">Settings</span>
      <button class="text-zinc-500 transition-colors hover:text-zinc-300" @click="emit('close')">
        ✕
      </button>
    </div>

    <!-- Interval slider -->
    <label class="mb-3 block">
      <span class="text-[11px] text-zinc-400">Interval: {{ interval }} min</span>
      <input
        v-model.number="interval"
        type="range"
        min="30"
        max="90"
        step="5"
        class="mt-1 block w-full accent-emerald-500"
      />
    </label>

    <!-- Break types -->
    <div class="mb-3">
      <span class="text-[11px] text-zinc-400">Break types</span>
      <div class="mt-1 flex flex-wrap gap-1">
        <button
          v-for="t in BREAK_TYPES"
          :key="t"
          class="rounded px-2 py-0.5 text-[10px] font-medium transition-colors"
          :class="
            enabledTypes.has(t)
              ? 'bg-emerald-600/20 text-emerald-400'
              : 'bg-zinc-700/50 text-zinc-500'
          "
          @click="toggleType(t)"
        >
          {{ BREAK_TYPE_LABELS[t] }}
        </button>
      </div>
    </div>

    <!-- Sound toggle -->
    <label class="mb-3 flex items-center gap-2">
      <input v-model="soundEnabled" type="checkbox" class="rounded accent-emerald-500" />
      <span class="text-[11px] text-zinc-400">Sound on escalation</span>
    </label>

    <button
      class="w-full rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-500"
      @click="save"
    >
      Save
    </button>
  </div>
</template>
