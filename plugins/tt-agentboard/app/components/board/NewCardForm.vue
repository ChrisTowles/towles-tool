<script setup lang="ts">
interface Repo {
  id: number;
  name: string;
  org: string | null;
  slotPaths?: string[];
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
const startColumn = ref<"ready" | "backlog">("ready");
const submitting = ref(false);
const submitError = ref("");
const improving = ref(false);

const { data: repos } = useFetch<Repo[]>("/api/repos");
const cardStore = useCardStore();
const { createCard } = cardStore;
const { isListening, transcript, interimTranscript, isSupported, toggle } = useVoice();

interface CardTemplate {
  name: string;
  description: string;
  prompt: string;
  executionMode: "headless" | "interactive";
  branchMode: "create" | "current";
  column: "ready" | "backlog";
}

const { data: templates } = useFetch<CardTemplate[]>("/api/cards/templates");

function applyTemplate(template: CardTemplate) {
  prompt.value = template.prompt.trim();
  executionMode.value = template.executionMode;
  branchMode.value = template.branchMode;
  startColumn.value = template.column;
}

// Top 5 most-used repos based on existing cards
const quickSelectRepos = computed(() => {
  if (!repos.value?.length) return [];
  const counts = new Map<number, number>();
  for (const card of cardStore.cards) {
    if (card.repoId != null) {
      counts.set(card.repoId, (counts.get(card.repoId) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id]) => repos.value!.find((r) => r.id === id))
    .filter((r): r is Repo => r != null);
});

// Snapshot prompt text before dictation starts so we can append to it
const promptBeforeDictation = ref("");

function toggleVoice() {
  if (!isListening.value) {
    // Capture current prompt BEFORE toggle clears transcript
    promptBeforeDictation.value = prompt.value;
  }
  toggle();
}

// Sync transcript + interim into prompt textarea in real-time
watch([transcript, interimTranscript], ([final, interim]) => {
  if (!isListening.value && !final) return;
  const base = promptBeforeDictation.value;
  const combined = `${final}${interim}`;
  prompt.value = base ? `${base} ${combined}` : combined;
});

function generateTitle(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() ?? text.trim();
  if (firstLine.length <= 60) return firstLine;
  return firstLine.slice(0, 57) + "...";
}

async function improvePrompt() {
  if (!prompt.value.trim() || improving.value) return;
  improving.value = true;
  submitError.value = "";
  try {
    const { improved } = await $fetch<{ improved: string }>("/api/prompts/improve", {
      method: "POST",
      body: { prompt: prompt.value.trim() },
    });
    if (improved) {
      prompt.value = improved;
    }
  } catch (e) {
    submitError.value = e instanceof Error ? e.message : "Failed to improve prompt";
  } finally {
    improving.value = false;
  }
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
    column: startColumn.value,
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
        <!-- Template picker -->
        <div v-if="templates?.length" class="mb-3">
          <label class="mb-1 block text-xs font-medium text-zinc-400">Template</label>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="tmpl in templates"
              :key="tmpl.name"
              type="button"
              class="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 transition-colors hover:border-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
              :title="tmpl.description"
              @click="applyTemplate(tmpl)"
            >
              {{ tmpl.name }}
            </button>
          </div>
        </div>

        <!-- Prompt -->
        <div>
          <label
            class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-zinc-400"
          >
            Prompt <span class="text-red-400">*</span>
          </label>
          <textarea
            v-model="prompt"
            rows="4"
            placeholder="What should the agent do? e.g. Fix the login bug in auth.ts — the session token expires too early..."
            autofocus
            class="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
          />
          <div class="mt-1.5 flex items-center justify-between">
            <p class="text-[10px] text-zinc-600">
              First line becomes the card title. Full text is sent as the prompt to Claude.
            </p>
            <div class="flex gap-1.5">
              <button
                type="button"
                :disabled="!prompt.trim() || improving"
                class="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-amber-500 hover:bg-amber-500/10 hover:text-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
                :class="improving ? 'border-amber-500 bg-amber-500/10 text-amber-400 animate-pulse' : ''"
                @click="improvePrompt"
              >
                {{ improving ? "Improving..." : "Improve" }}
              </button>
              <button
                v-if="isSupported"
                type="button"
                class="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all"
                :class="
                  isListening
                    ? 'border-red-500 bg-red-500/10 text-red-400 animate-pulse'
                    : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-700'
                "
                @click="toggleVoice"
              >
                <span class="text-sm">{{ isListening ? "●" : "🎤" }}</span>
                {{ isListening ? "Stop" : "Dictate" }}
              </button>
            </div>
          </div>
        </div>

        <!-- Repo selector -->
        <div>
          <label
            class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-zinc-400"
          >
            Repository
          </label>
          <!-- Quick select: top 5 most-used repos -->
          <div v-if="quickSelectRepos.length" class="mb-2 flex flex-wrap gap-1.5">
            <button
              v-for="repo in quickSelectRepos"
              :key="repo.id"
              type="button"
              class="rounded-md border px-2.5 py-1 text-xs font-medium transition-colors"
              :class="
                repoId === repo.id
                  ? 'border-blue-500 bg-blue-500/15 text-blue-400'
                  : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-700'
              "
              @click="repoId = repoId === repo.id ? undefined : repo.id"
            >
              {{ repo.org ? `${repo.org}/` : "" }}{{ repo.name }}
            </button>
          </div>
          <select
            v-model="repoId"
            class="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:border-blue-500 focus:outline-none"
          >
            <option :value="undefined">None</option>
            <option v-for="repo in repos" :key="repo.id" :value="repo.id">
              {{ repo.org ? `${repo.org}/` : "" }}{{ repo.name
              }}{{
                repo.slotPaths?.length
                  ? ` (${repo.slotPaths.map((p) => p.split("/").pop()).join(", ")})`
                  : ""
              }}
            </option>
          </select>
          <p v-if="repos && repos.length === 0" class="mt-1.5 text-[11px] text-amber-500/80">
            No repos registered. Add a workspace slot in
            <NuxtLink to="/workspaces" class="font-medium underline">Workspaces</NuxtLink>
            first to enable agent execution.
          </p>
        </div>

        <!-- Start column -->
        <div>
          <label
            class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-zinc-400"
          >
            Start In
          </label>
          <div class="flex gap-2">
            <button
              type="button"
              class="flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors"
              :class="
                startColumn === 'ready'
                  ? 'border-cyan-500 bg-cyan-500/10 text-cyan-400'
                  : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600'
              "
              @click="startColumn = 'ready'"
            >
              Ready
            </button>
            <button
              type="button"
              class="flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors"
              :class="
                startColumn === 'backlog'
                  ? 'border-zinc-500 bg-zinc-500/10 text-zinc-300'
                  : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600'
              "
              @click="startColumn = 'backlog'"
            >
              Backlog
            </button>
          </div>
          <p class="mt-1.5 text-[11px] text-zinc-600">
            Ready cards can be started immediately. Backlog cards are parked for later.
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
