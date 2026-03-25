<script setup lang="ts">
import type { Card } from "~/composables/useCards";

const props = defineProps<{
  card: Card;
}>();

const emit = defineEmits<{
  archive: [];
  retry: [];
  start: [];
}>();

const open = ref(false);
const toast = ref("");
const toastTimeout = ref<ReturnType<typeof setTimeout> | null>(null);

function showToast(message: string) {
  toast.value = message;
  if (toastTimeout.value) clearTimeout(toastTimeout.value);
  toastTimeout.value = setTimeout(() => {
    toast.value = "";
  }, 2000);
}

function closeMenu() {
  open.value = false;
}

async function openVSCode() {
  closeMenu();
  try {
    await $fetch(`/api/agents/${props.card.id}/open-vscode`);
    showToast("Opened in VS Code");
  } catch {
    showToast("Failed to open VS Code");
  }
}

function copyTmuxCommand() {
  closeMenu();
  navigator.clipboard.writeText(`tmux attach -t card-${props.card.id}`);
  showToast("Copied!");
}

async function openTerminal() {
  closeMenu();
  try {
    await $fetch(`/api/agents/${props.card.id}/attach`, { method: "POST" });
    showToast("Terminal attached");
  } catch {
    showToast("Failed to attach terminal");
  }
}

function startAgent() {
  closeMenu();
  emit("start");
}

function retryCard() {
  closeMenu();
  emit("retry");
}

function copyPrompt() {
  closeMenu();
  navigator.clipboard.writeText(props.card.description ?? props.card.title);
  showToast("Copied!");
}

async function createGitHubIssue() {
  closeMenu();
  try {
    const result = await $fetch<{ issueNumber: number; htmlUrl: string }>("/api/github/issues", {
      method: "POST",
      body: { cardId: props.card.id },
    });
    showToast(`Created issue #${result.issueNumber}`);
  } catch {
    showToast("Failed to create issue");
  }
}

function archiveCard() {
  closeMenu();
  emit("archive");
}

// Close on outside click
function onClickOutside(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (!target.closest("[data-card-actions]")) {
    open.value = false;
  }
}

onMounted(() => document.addEventListener("click", onClickOutside));
onUnmounted(() => {
  document.removeEventListener("click", onClickOutside);
  if (toastTimeout.value) clearTimeout(toastTimeout.value);
});
</script>

<template>
  <div class="relative" data-card-actions>
    <!-- Trigger -->
    <button
      class="rounded px-1.5 py-0.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
      title="Card actions"
      @click.stop="open = !open"
    >
      ⋮
    </button>

    <!-- Dropdown -->
    <Transition name="fade">
      <div
        v-if="open"
        class="absolute right-0 top-full z-50 mt-1 w-48 rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl"
      >
        <button
          v-if="card.status === 'idle' || card.status === 'queued'"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-blue-400 transition-colors hover:bg-zinc-800"
          @click="startAgent"
        >
          <span class="w-4 text-center text-[10px]">▶</span>
          Start Agent
        </button>

        <div
          v-if="card.status === 'idle' || card.status === 'queued'"
          class="my-1 border-t border-zinc-800"
        />

        <button
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
          @click="openVSCode"
        >
          <span class="w-4 text-center text-[10px]">⎔</span>
          Open in VS Code
        </button>

        <button
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
          @click="copyTmuxCommand"
        >
          <span class="w-4 text-center text-[10px]">⌘</span>
          Copy tmux command
        </button>

        <button
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
          @click="openTerminal"
        >
          <span class="w-4 text-center text-[10px]">▶</span>
          Open terminal
        </button>

        <button
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
          @click="copyPrompt"
        >
          <span class="w-4 text-center text-[10px]">⧉</span>
          Copy prompt
        </button>

        <button
          v-if="card.repoId && !card.githubIssueNumber"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
          @click="createGitHubIssue"
        >
          <span class="w-4 text-center text-[10px]">⊕</span>
          Create GitHub Issue
        </button>

        <div
          v-if="card.status === 'failed' || card.status === 'review_ready'"
          class="my-1 border-t border-zinc-800"
        />

        <button
          v-if="card.status === 'failed'"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-amber-400 transition-colors hover:bg-zinc-800"
          @click="retryCard"
        >
          <span class="w-4 text-center text-[10px]">↻</span>
          Retry
        </button>

        <button
          v-if="card.status === 'review_ready'"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-amber-400 transition-colors hover:bg-zinc-800"
          @click="retryCard"
        >
          <span class="w-4 text-center text-[10px]">↻</span>
          Rerun
        </button>

        <button
          v-if="card.status === 'review_ready'"
          class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-emerald-400 transition-colors hover:bg-zinc-800"
          @click="archiveCard"
        >
          <span class="w-4 text-center text-[10px]">✓</span>
          Archive
        </button>
      </div>
    </Transition>

    <!-- Toast -->
    <Transition name="fade">
      <div
        v-if="toast"
        class="absolute right-0 top-full z-50 mt-1 rounded bg-zinc-800 px-2.5 py-1.5 text-[10px] font-medium text-zinc-200 shadow-lg"
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
