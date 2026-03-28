<script setup lang="ts">
import type { Card } from "~/stores/cards";

const props = defineProps<{
  card: Card;
}>();

const { openUrl } = useServerOpen();
const toast = ref("");
const toastTimeout = ref<ReturnType<typeof setTimeout> | null>(null);

function showToast(message: string) {
  toast.value = message;
  if (toastTimeout.value) clearTimeout(toastTimeout.value);
  toastTimeout.value = setTimeout(() => {
    toast.value = "";
  }, 2000);
}

async function openVSCode() {
  try {
    await $fetch(`/api/agents/${props.card.id}/open-vscode`);
    showToast("Opened in VS Code");
  } catch {
    showToast("Failed to open VS Code");
  }
}

async function openTerminal() {
  try {
    await $fetch(`/api/agents/${props.card.id}/attach`, { method: "POST" });
    showToast("Terminal attached");
  } catch {
    showToast("Failed to attach terminal");
  }
}

const branchUrl = computed(() => {
  if (!props.card.branch || !props.card.repo) return null;
  if (props.card.repo.githubUrl) {
    return `${props.card.repo.githubUrl}/tree/${props.card.branch}`;
  }
  if (props.card.repo.org && props.card.repo.name) {
    return `https://github.com/${props.card.repo.org}/${props.card.repo.name}/tree/${props.card.branch}`;
  }
  return null;
});

async function viewOnGitHub() {
  if (branchUrl.value) {
    try {
      await openUrl(branchUrl.value);
      showToast("Opened in browser");
    } catch {
      showToast("Failed to open browser");
    }
  }
}

onUnmounted(() => {
  if (toastTimeout.value) clearTimeout(toastTimeout.value);
});
</script>

<template>
  <div class="relative flex items-center gap-1">
    <!-- VS Code -->
    <button
      class="rounded p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
      title="Open in VS Code"
      @click="openVSCode"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M71.6 0L34.8 33.4 14.2 18.2 0 24v52l14.2 5.8L34.8 66.6 71.6 100l28.4-12V12L71.6 0zM34.8 62.2L14.2 50l20.6-12.2v24.4zM71.6 76L50 50l21.6-26v52z"
          fill="currentColor"
        />
      </svg>
    </button>

    <!-- Terminal (tmux) -->
    <button
      class="rounded p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
      title="Open terminal"
      @click="openTerminal"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    </button>

    <!-- GitHub -->
    <button
      v-if="branchUrl"
      class="rounded p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
      title="View on GitHub"
      @click="viewOnGitHub"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path
          d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"
        />
      </svg>
    </button>

    <!-- Toast -->
    <Transition name="fade">
      <div
        v-if="toast"
        class="absolute right-0 top-full z-50 mt-1 whitespace-nowrap rounded bg-zinc-800 px-2.5 py-1.5 text-[10px] font-medium text-zinc-200 shadow-lg"
      >
        {{ toast }}
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
