<script setup lang="ts">
interface Repo {
  id: number;
  name: string;
  org: string | null;
}

const props = defineProps<{
  initialTitle?: string;
}>();

const emit = defineEmits<{
  created: [];
  cancel: [];
}>();

const prompt = ref(props.initialTitle ?? "");
const repoId = ref<number | undefined>(undefined);
const workflowId = ref<string | undefined>(undefined);
const executionMode = ref<"headless" | "interactive">("headless");
const branchMode = ref<"create" | "current">("create");
const submitting = ref(false);
const submitError = ref("");

const { data: repos } = useFetch<Repo[]>("/api/repos");
const { createCard } = useCards();

function generateTitle(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() ?? text.trim();
  if (firstLine.length <= 60) return firstLine;
  return firstLine.slice(0, 57) + "...";
}

async function submit() {
  if (!prompt.value.trim() || submitting.value) return;
  submitError.value = "";
  submitting.value = true;
  const text = prompt.value.trim();
  const card = await createCard({
    title: generateTitle(text),
    description: text,
    repoId: repoId.value,
    workflowId: workflowId.value || undefined,
    executionMode: executionMode.value,
    branchMode: branchMode.value,
  });
  submitting.value = false;
  if (card) {
    prompt.value = "";
    repoId.value = undefined;
    workflowId.value = undefined;
    executionMode.value = "headless";
    branchMode.value = "create";
    emit("created");
  } else {
    submitError.value = "Failed to create card. Check the server logs for details.";
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-20"
    @click.self="emit('cancel')"
  >
    <div class="w-full max-w-lg rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
      <!-- Header -->
      <div class="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
        <h2 class="text-sm font-bold text-zinc-100">New Card</h2>
        <button
          class="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
          @click="emit('cancel')"
        >
          ✕
        </button>
      </div>

      <!-- Form -->
      <form class="space-y-4 px-5 py-4" @submit.prevent="submit">
        <!-- Prompt -->
        <div>
          <div class="mb-1.5 flex items-center justify-between">
            <label class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
              Prompt <span class="text-red-400">*</span>
            </label>
            <ClientOnly>
              <VoiceInput
                @transcription="(text: string) => (prompt = prompt ? `${prompt} ${text}` : text)"
              />
            </ClientOnly>
          </div>
          <textarea
            v-model="prompt"
            rows="4"
            placeholder="What should the agent do? e.g. Fix the login bug in auth.ts — the session token expires too early..."
            autofocus
            class="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
          />
          <p class="mt-1 text-[10px] text-zinc-600">
            First line becomes the card title. Full text is sent as the prompt to Claude.
          </p>
        </div>

        <!-- Repo selector -->
        <div>
          <label
            class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-zinc-400"
          >
            Repository
          </label>
          <select
            v-model="repoId"
            class="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:border-blue-500 focus:outline-none"
          >
            <option :value="undefined">None</option>
            <option v-for="repo in repos" :key="repo.id" :value="repo.id">
              {{ repo.org ? `${repo.org}/` : "" }}{{ repo.name }}
            </option>
          </select>
          <p v-if="repos && repos.length === 0" class="mt-1.5 text-[11px] text-amber-500/80">
            No repos registered. Add a workspace slot in
            <NuxtLink to="/workspaces" class="font-medium underline">Workspaces</NuxtLink>
            first to enable agent execution.
          </p>
        </div>

        <!-- Execution mode toggle -->
        <div>
          <label
            class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-zinc-400"
          >
            Execution Mode
          </label>
          <div class="flex gap-2">
            <button
              type="button"
              class="flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors"
              :class="
                executionMode === 'headless'
                  ? 'border-blue-500 bg-blue-500/10 text-blue-400'
                  : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600'
              "
              @click="executionMode = 'headless'"
            >
              ⚡ Headless
            </button>
            <button
              type="button"
              class="flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors"
              :class="
                executionMode === 'interactive'
                  ? 'border-blue-500 bg-blue-500/10 text-blue-400'
                  : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600'
              "
              @click="executionMode = 'interactive'"
            >
              ⌨ Interactive
            </button>
          </div>
          <p class="mt-1.5 text-[11px] text-zinc-600">
            {{
              executionMode === "headless"
                ? "Runs autonomously with --dangerously-skip-permissions."
                : "Runs in tmux — attach to interact with the agent."
            }}
          </p>
        </div>

        <!-- Branch mode toggle -->
        <div>
          <label
            class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-zinc-400"
          >
            Branch
          </label>
          <div class="flex gap-2">
            <button
              type="button"
              class="flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors"
              :class="
                branchMode === 'create'
                  ? 'border-violet-500 bg-violet-500/10 text-violet-400'
                  : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600'
              "
              @click="branchMode = 'create'"
            >
              New Branch
            </button>
            <button
              type="button"
              class="flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors"
              :class="
                branchMode === 'current'
                  ? 'border-violet-500 bg-violet-500/10 text-violet-400'
                  : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600'
              "
              @click="branchMode = 'current'"
            >
              Current Branch
            </button>
          </div>
          <p class="mt-1.5 text-[11px] text-zinc-600">
            {{
              branchMode === "create"
                ? "Creates a new git branch for this work (recommended for PRs)."
                : "Stays on the current branch — use for quick fixes or manual branch management."
            }}
          </p>
        </div>

        <!-- Error -->
        <div
          v-if="submitError"
          class="rounded-lg border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-400"
        >
          {{ submitError }}
        </div>

        <!-- Actions -->
        <div class="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            class="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-700"
            @click="emit('cancel')"
          >
            Cancel
          </button>
          <button
            type="submit"
            :disabled="!prompt.trim() || submitting"
            class="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {{ submitting ? "Creating..." : "Create Card" }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
