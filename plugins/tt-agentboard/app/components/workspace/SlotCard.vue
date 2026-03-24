<script setup lang="ts">
export interface Slot {
  id: number;
  repoId: number;
  path: string;
  portConfig: string | null;
  envPath: string | null;
  status: 'available' | 'claimed' | 'locked';
  claimedByCardId: number | null;
  createdAt: string;
}

const props = defineProps<{
  slot: Slot;
  repoName?: string;
}>();

const emit = defineEmits<{
  lock: [slotId: number, locked: boolean];
  remove: [slotId: number];
}>();

const statusColors: Record<string, string> = {
  available: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
  claimed: 'text-blue-400 bg-blue-500/10 border-blue-500/30',
  locked: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
};

const parsedPorts = computed(() => {
  if (!props.slot.portConfig) return null;
  try {
    return JSON.parse(props.slot.portConfig) as Record<string, number>;
  } catch {
    return null;
  }
});
</script>

<template>
  <div class="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 transition-colors hover:border-zinc-700">
    <!-- Header -->
    <div class="mb-3 flex items-start justify-between">
      <div>
        <div class="flex items-center gap-2">
          <span class="text-sm font-semibold text-zinc-200">{{ repoName || `Repo #${slot.repoId}` }}</span>
          <span
            class="rounded border px-1.5 py-0.5 text-[10px] font-mono font-semibold uppercase"
            :class="statusColors[slot.status]"
          >
            {{ slot.status }}
          </span>
        </div>
        <p class="mt-1 font-mono text-xs text-zinc-500 break-all">{{ slot.path }}</p>
      </div>
    </div>

    <!-- Details -->
    <div class="mb-3 space-y-1.5">
      <div v-if="parsedPorts" class="flex flex-wrap gap-2">
        <span
          v-for="(port, name) in parsedPorts"
          :key="name"
          class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-mono text-zinc-400"
        >
          {{ name }}:{{ port }}
        </span>
      </div>
      <div v-if="slot.envPath" class="flex items-center gap-1 text-[10px] font-mono text-zinc-500">
        <span class="text-zinc-600">env:</span> {{ slot.envPath }}
      </div>
      <div v-if="slot.claimedByCardId" class="text-[10px] font-mono text-blue-400">
        claimed by card #{{ slot.claimedByCardId }}
      </div>
    </div>

    <!-- Actions -->
    <div class="flex items-center gap-2">
      <button
        v-if="slot.status === 'available'"
        class="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-400 transition-colors hover:bg-amber-500/20"
        @click="emit('lock', slot.id, true)"
      >
        Lock
      </button>
      <button
        v-if="slot.status === 'locked'"
        class="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-400 transition-colors hover:bg-emerald-500/20"
        @click="emit('lock', slot.id, false)"
      >
        Unlock
      </button>
      <button
        v-if="slot.status !== 'claimed'"
        class="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] font-medium text-red-400 transition-colors hover:bg-red-500/20"
        @click="emit('remove', slot.id)"
      >
        Remove
      </button>
    </div>
  </div>
</template>
