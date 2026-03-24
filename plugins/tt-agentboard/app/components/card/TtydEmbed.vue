<script setup lang="ts">
const props = defineProps<{
  cardId: number;
}>();

const attached = ref(false);
const ttydUrl = ref("");
const loading = ref(false);
const error = ref("");

async function attach() {
  loading.value = true;
  error.value = "";
  try {
    const data = await $fetch<{ attached: boolean; port: number; url: string }>(
      `/api/agents/${props.cardId}/attach`,
      { method: "POST" },
    );
    if (data.attached) {
      attached.value = true;
      // Use current hostname (for LAN access) with ttyd port
      const host = window.location.hostname;
      ttydUrl.value = `http://${host}:${data.port}`;
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to attach";
  } finally {
    loading.value = false;
  }
}

async function detach() {
  try {
    await $fetch(`/api/agents/${props.cardId}/attach`, {
      method: "POST",
      body: { action: "detach" },
    });
  } catch {
    // Best effort
  }
  attached.value = false;
  ttydUrl.value = "";
}

onUnmounted(() => {
  if (attached.value) {
    detach();
  }
});
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Controls -->
    <div class="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
      <div class="flex items-center gap-2">
        <span class="h-2 w-2 rounded-full" :class="attached ? 'bg-emerald-500' : 'bg-zinc-600'" />
        <span class="text-[10px] font-mono text-zinc-500">ttyd</span>
      </div>
      <div>
        <button
          v-if="!attached"
          :disabled="loading"
          class="rounded px-2 py-1 text-[10px] font-medium text-blue-400 transition-colors hover:bg-zinc-800"
          @click="attach"
        >
          {{ loading ? "Attaching..." : "Attach" }}
        </button>
        <button
          v-else
          class="rounded px-2 py-1 text-[10px] font-medium text-red-400 transition-colors hover:bg-zinc-800"
          @click="detach"
        >
          Detach
        </button>
      </div>
    </div>

    <!-- Error -->
    <div
      v-if="error"
      class="mx-3 mt-2 rounded border border-red-900 bg-red-950/50 px-3 py-2 text-[10px] text-red-400"
    >
      Could not attach to terminal. The tmux session may not exist yet.
    </div>

    <!-- iframe -->
    <div v-if="attached && ttydUrl" class="flex-1">
      <iframe
        :src="ttydUrl"
        class="h-full w-full border-0"
        allow="clipboard-read; clipboard-write"
      />
    </div>

    <!-- Placeholder -->
    <div
      v-else-if="!attached"
      class="flex flex-1 items-center justify-center text-xs text-zinc-600"
    >
      Click "Attach" for interactive terminal access
    </div>
  </div>
</template>
