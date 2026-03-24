<script setup lang="ts">
interface Repo {
  id: number;
  name: string;
  org: string | null;
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: string[];
  html_url: string;
}

const emit = defineEmits<{
  imported: [];
  cancel: [];
}>();

const { createCard } = useCards();
const { data: repos } = useFetch<Repo[]>("/api/repos");

const selectedRepoId = ref<number | undefined>(undefined);
const issues = ref<GitHubIssue[]>([]);
const selected = ref<Set<number>>(new Set());
const loadingIssues = ref(false);
const importing = ref(false);
const error = ref<string | null>(null);

async function fetchIssues() {
  if (!selectedRepoId.value) return;
  loadingIssues.value = true;
  error.value = null;
  issues.value = [];
  selected.value = new Set();
  try {
    issues.value = await $fetch<GitHubIssue[]>("/api/github/issues", {
      query: { repoId: selectedRepoId.value },
    });
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to fetch issues";
  } finally {
    loadingIssues.value = false;
  }
}

function toggleIssue(num: number) {
  const s = new Set(selected.value);
  if (s.has(num)) {
    s.delete(num);
  } else {
    s.add(num);
  }
  selected.value = s;
}

function toggleAll() {
  if (selected.value.size === issues.value.length) {
    selected.value = new Set();
  } else {
    selected.value = new Set(issues.value.map((i) => i.number));
  }
}

async function importSelected() {
  if (selected.value.size === 0 || !selectedRepoId.value) return;
  importing.value = true;
  for (const issue of issues.value.filter((i) => selected.value.has(i.number))) {
    const card = await createCard({
      title: issue.title,
      description: issue.body ?? undefined,
      repoId: selectedRepoId.value,
    });
    if (card) {
      await $fetch(`/api/cards/${card.id}/link-issue`, {
        method: "POST",
        body: { issueNumber: issue.number },
      });
    }
  }
  importing.value = false;
  emit("imported");
}

watch(selectedRepoId, () => {
  fetchIssues();
});
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-20"
    @click.self="emit('cancel')"
  >
    <div class="w-full max-w-lg rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
      <!-- Header -->
      <div class="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
        <h2 class="text-sm font-bold text-zinc-100">Import GitHub Issues</h2>
        <button
          class="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
          @click="emit('cancel')"
        >
          ✕
        </button>
      </div>

      <div class="space-y-4 px-5 py-4">
        <!-- Repo selector -->
        <div>
          <label
            class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-zinc-400"
          >
            Repository
          </label>
          <select
            v-model="selectedRepoId"
            class="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:border-blue-500 focus:outline-none"
          >
            <option :value="undefined" disabled>Select a repository</option>
            <option v-for="repo in repos" :key="repo.id" :value="repo.id">
              {{ repo.org ? `${repo.org}/` : "" }}{{ repo.name }}
            </option>
          </select>
        </div>

        <!-- Loading -->
        <div v-if="loadingIssues" class="flex items-center gap-2 text-sm text-zinc-500">
          <span
            class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-zinc-600 border-t-blue-400"
          />
          Fetching issues...
        </div>

        <!-- Error -->
        <div
          v-else-if="error"
          class="rounded-lg border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-400"
        >
          {{ error }}
        </div>

        <!-- Issues list -->
        <div v-else-if="issues.length > 0" class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
              {{ issues.length }} open issue{{ issues.length === 1 ? "" : "s" }}
            </span>
            <button
              class="text-[11px] font-medium text-blue-400 hover:text-blue-300"
              @click="toggleAll"
            >
              {{ selected.size === issues.length ? "Deselect all" : "Select all" }}
            </button>
          </div>
          <div class="max-h-64 space-y-1 overflow-y-auto">
            <button
              v-for="issue in issues"
              :key="issue.number"
              class="flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition-colors"
              :class="selected.has(issue.number) ? 'bg-blue-500/10' : 'hover:bg-zinc-800'"
              @click="toggleIssue(issue.number)"
            >
              <span
                class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px]"
                :class="
                  selected.has(issue.number)
                    ? 'border-blue-500 bg-blue-500 text-white'
                    : 'border-zinc-600'
                "
              >
                {{ selected.has(issue.number) ? "✓" : "" }}
              </span>
              <div class="min-w-0 flex-1">
                <div class="text-xs font-medium text-zinc-200">
                  <span class="font-mono text-zinc-500">#{{ issue.number }}</span>
                  {{ issue.title }}
                </div>
                <div v-if="issue.labels.length" class="mt-1 flex flex-wrap gap-1">
                  <span
                    v-for="label in issue.labels"
                    :key="label"
                    class="rounded-full bg-zinc-800 px-1.5 py-0.5 text-[9px] font-mono text-zinc-400"
                  >
                    {{ label }}
                  </span>
                </div>
              </div>
            </button>
          </div>
        </div>

        <!-- Empty state -->
        <div
          v-else-if="selectedRepoId && !loadingIssues"
          class="py-4 text-center text-xs text-zinc-500"
        >
          No open issues found.
        </div>

        <!-- Actions -->
        <div class="flex items-center justify-end gap-2 border-t border-zinc-800 pt-4">
          <button
            class="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-700"
            @click="emit('cancel')"
          >
            Cancel
          </button>
          <button
            :disabled="selected.size === 0 || importing"
            class="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            @click="importSelected"
          >
            {{
              importing
                ? "Importing..."
                : `Import ${selected.size} issue${selected.size === 1 ? "" : "s"}`
            }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
