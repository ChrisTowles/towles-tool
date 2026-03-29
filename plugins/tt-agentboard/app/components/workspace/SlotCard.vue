<script setup lang="ts">
export interface Slot {
  id: number;
  repoId: number;
  path: string;
  portConfig: string | null;
  envPath: string | null;
  status: "available" | "claimed" | "locked";
  claimedByCardId: number | null;
  createdAt: string;
}

interface GitInfo {
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: boolean | null;
  lastCommitDate: string | null;
  isStale: boolean;
}

const props = defineProps<{
  slot: Slot;
  repoName?: string;
}>();

const emit = defineEmits<{
  lock: [slotId: number, locked: boolean];
  remove: [slotId: number];
  refresh: [];
}>();

const statusColors: Record<string, string> = {
  available: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30",
  claimed: "text-blue-400 bg-blue-500/10 border-blue-500/30",
  locked: "text-amber-400 bg-amber-500/10 border-amber-500/30",
};

const gitInfo = ref<GitInfo | null>(null);
const resetting = ref(false);
const releasing = ref(false);

const lastCommitAgo = computed(() => {
  if (!gitInfo.value?.lastCommitDate) return null;
  const days = Math.floor(
    (Date.now() - new Date(gitInfo.value.lastCommitDate).getTime()) / 86_400_000,
  );
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
});

const parsedPorts = computed(() => {
  if (!props.slot.portConfig) return null;
  try {
    return JSON.parse(props.slot.portConfig) as Record<string, number>;
  } catch {
    return null;
  }
});

async function fetchGitInfo() {
  try {
    gitInfo.value = await $fetch<GitInfo>(`/api/slots/${props.slot.id}/git-info`);
  } catch {
    gitInfo.value = null;
  }
}

async function releaseSlot() {
  releasing.value = true;
  try {
    await $fetch(`/api/slots/${props.slot.id}/release`, { method: "POST" });
    emit("refresh");
  } finally {
    releasing.value = false;
  }
}

async function resetToMain() {
  resetting.value = true;
  try {
    await $fetch(`/api/slots/${props.slot.id}/reset`, { method: "POST" });
    await fetchGitInfo();
  } finally {
    resetting.value = false;
  }
}

onMounted(() => {
  fetchGitInfo();
});

watch(() => props.slot.status, fetchGitInfo);
</script>

<template>
  <div
    class="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 transition-colors hover:border-zinc-700"
  >
    <!-- Header -->
    <div class="mb-3 flex items-start justify-between">
      <div>
        <div class="flex items-center gap-2">
          <span class="text-sm font-semibold text-zinc-200">{{
            repoName || `Repo #${slot.repoId}`
          }}</span>
          <span
            class="rounded border px-1.5 py-0.5 text-[10px] font-mono font-semibold uppercase"
            :class="statusColors[slot.status]"
          >
            {{ slot.status }}
          </span>
          <span
            v-if="gitInfo?.isStale"
            class="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400"
          >
            Stale
          </span>
          <span
            v-if="gitInfo?.dirty"
            class="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-400"
          >
            Dirty
          </span>
        </div>
        <p class="mt-1 font-mono text-xs text-zinc-500 break-all">{{ slot.path }}</p>

        <!-- Git info -->
        <div v-if="gitInfo" class="mt-1 flex flex-wrap items-center gap-2">
          <span
            v-if="gitInfo.branch"
            class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-mono text-zinc-400"
          >
            {{ gitInfo.branch }}
          </span>
          <span
            v-if="gitInfo.ahead !== null && gitInfo.ahead > 0"
            class="rounded bg-emerald-500/10 px-1 py-0.5 text-[10px] font-mono text-emerald-400"
          >
            ↑{{ gitInfo.ahead }}
          </span>
          <span
            v-if="gitInfo.behind !== null && gitInfo.behind > 0"
            class="rounded bg-amber-500/10 px-1 py-0.5 text-[10px] font-mono text-amber-400"
          >
            ↓{{ gitInfo.behind }}
          </span>
          <span
            v-if="gitInfo.dirty"
            class="rounded bg-red-500/10 px-1 py-0.5 text-[10px] font-mono text-red-400"
          >
            dirty
          </span>
          <span v-if="lastCommitAgo" class="text-[10px] text-zinc-600">
            Last commit: {{ lastCommitAgo }}
          </span>
        </div>
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

    <!-- Stale/Dirty reset prompt -->
    <div v-if="gitInfo?.isStale || gitInfo?.dirty" class="mb-3">
      <button
        type="button"
        class="rounded border border-amber-700 bg-amber-950/50 px-2 py-1 text-[10px] font-medium text-amber-400 transition-colors hover:bg-amber-900/50"
        :disabled="resetting"
        @click="resetToMain"
      >
        {{ resetting ? "Resetting..." : "Reset to main" }}
      </button>
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
        v-if="slot.status === 'claimed'"
        :disabled="releasing"
        class="rounded border border-orange-500/30 bg-orange-500/10 px-2 py-1 text-[11px] font-medium text-orange-400 transition-colors hover:bg-orange-500/20 disabled:opacity-40"
        @click="releaseSlot"
      >
        {{ releasing ? "Freeing..." : "Free" }}
      </button>
      <button
        v-if="slot.status === 'available' || slot.status === 'locked'"
        :disabled="resetting"
        class="rounded border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-[11px] font-medium text-cyan-400 transition-colors hover:bg-cyan-500/20 disabled:opacity-40"
        @click="resetToMain"
      >
        {{ resetting ? "Resetting..." : "Reset to Main" }}
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
