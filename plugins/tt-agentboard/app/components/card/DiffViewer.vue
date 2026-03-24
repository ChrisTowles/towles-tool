<script setup lang="ts">
const props = defineProps<{
  cardId: number;
}>();

interface DiffLine {
  type: "add" | "delete" | "context";
  content: string;
}

interface DiffChunk {
  header: string;
  lines: DiffLine[];
}

interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  chunks: DiffChunk[];
}

interface DiffResponse {
  hasDiff: boolean;
  files: DiffFile[];
  raw: string;
}

const diff = ref<DiffResponse | null>(null);
const loading = ref(true);
const collapsedFiles = ref<Set<string>>(new Set());

function toggleFile(path: string) {
  if (collapsedFiles.value.has(path)) {
    collapsedFiles.value.delete(path);
  } else {
    collapsedFiles.value.add(path);
  }
}

async function fetchDiff() {
  try {
    diff.value = await $fetch<DiffResponse>(`/api/agents/${props.cardId}/diff`);
  } catch {
    diff.value = null;
  } finally {
    loading.value = false;
  }
}

// Poll every 5s
const pollInterval = ref<ReturnType<typeof setInterval> | null>(null);

onMounted(() => {
  fetchDiff();
  pollInterval.value = setInterval(fetchDiff, 5000);
});

onUnmounted(() => {
  if (pollInterval.value) clearInterval(pollInterval.value);
});

watch(
  () => props.cardId,
  () => {
    loading.value = true;
    diff.value = null;
    collapsedFiles.value.clear();
    fetchDiff();
  },
);
</script>

<template>
  <div class="flex h-full flex-col rounded-lg border border-zinc-800 bg-zinc-950">
    <!-- Header -->
    <div class="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
      <div class="flex items-center gap-2">
        <span class="text-[10px] font-mono text-zinc-500">Git Diff</span>
      </div>
      <div v-if="diff?.hasDiff" class="flex items-center gap-2">
        <span class="text-[10px] font-mono text-zinc-500">
          {{ diff.files.length }} file{{ diff.files.length !== 1 ? "s" : "" }}
        </span>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex flex-1 items-center justify-center">
      <span class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-blue-400" />
    </div>

    <!-- No changes -->
    <div v-else-if="!diff?.hasDiff" class="flex flex-1 items-center justify-center">
      <p class="text-xs text-zinc-600">No changes detected</p>
    </div>

    <!-- Diff content -->
    <div v-else class="flex-1 overflow-y-auto font-mono text-xs">
      <div v-for="file in diff.files" :key="file.path" class="border-b border-zinc-800 last:border-b-0">
        <!-- File header -->
        <button
          class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-zinc-900"
          @click="toggleFile(file.path)"
        >
          <span class="text-zinc-600">{{ collapsedFiles.has(file.path) ? "▸" : "▾" }}</span>
          <span class="flex-1 truncate text-zinc-300">{{ file.path }}</span>
          <span class="text-emerald-400">+{{ file.additions }}</span>
          <span class="text-red-400">-{{ file.deletions }}</span>
        </button>

        <!-- Chunks -->
        <div v-if="!collapsedFiles.has(file.path)">
          <div v-for="(chunk, ci) in file.chunks" :key="ci">
            <!-- Chunk header -->
            <div class="bg-violet-950/30 px-3 py-0.5 text-violet-400">
              {{ chunk.header }}
            </div>
            <!-- Lines -->
            <div
              v-for="(line, li) in chunk.lines"
              :key="li"
              class="flex"
              :class="{
                'bg-emerald-950/40 text-emerald-300': line.type === 'add',
                'bg-red-950/40 text-red-300': line.type === 'delete',
                'text-zinc-500': line.type === 'context',
              }"
            >
              <span class="w-8 shrink-0 select-none border-r border-zinc-800/50 pr-1 text-right text-zinc-700">
                {{ line.type === "delete" ? "-" : line.type === "add" ? "+" : " " }}
              </span>
              <pre class="flex-1 whitespace-pre-wrap break-all px-2">{{ line.content }}</pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
