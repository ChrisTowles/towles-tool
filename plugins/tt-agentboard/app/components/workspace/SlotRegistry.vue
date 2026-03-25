<script setup lang="ts">
import type { Slot } from "~/components/workspace/SlotCard.vue";

interface Repo {
  id: number;
  name: string;
  org: string | null;
}

const slots = ref<Slot[]>([]);
const repos = ref<Repo[]>([]);
const loading = ref(false);
const showAddForm = ref(false);

// Scan paths config
const repoPaths = ref<string[]>([]);
const editingPaths = ref(false);
const editPathInput = ref("");

const form = reactive({
  repoId: 0,
  path: "",
  portConfig: "",
  envPath: "",
});

async function fetchData() {
  loading.value = true;
  try {
    const [slotsData, reposData, config] = await Promise.all([
      $fetch<Slot[]>("/api/slots"),
      $fetch<Repo[]>("/api/repos"),
      $fetch<{ repoPaths: string[] }>("/api/config"),
    ]);
    slots.value = slotsData;
    repos.value = reposData;
    repoPaths.value = config.repoPaths;
  } finally {
    loading.value = false;
  }
}

function startEditingPaths() {
  editingPaths.value = true;
  editPathInput.value = repoPaths.value.join("\n");
}

async function savePaths() {
  const paths = editPathInput.value
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
  await $fetch("/api/config", {
    method: "PUT",
    body: { repoPaths: paths },
  });
  repoPaths.value = paths;
  editingPaths.value = false;
}

async function addSlot() {
  if (!form.repoId || !form.path) return;

  let portConfig = null;
  if (form.portConfig.trim()) {
    try {
      portConfig = JSON.parse(form.portConfig);
    } catch {
      return;
    }
  }

  const slot = await $fetch<Slot>("/api/slots", {
    method: "POST",
    body: {
      repoId: form.repoId,
      path: form.path,
      portConfig,
      envPath: form.envPath || null,
    },
  });

  slots.value.push(slot);
  showAddForm.value = false;
  form.repoId = 0;
  form.path = "";
  form.portConfig = "";
  form.envPath = "";
}

async function toggleLock(slotId: number, locked: boolean) {
  const updated = await $fetch<Slot>(`/api/slots/${slotId}/lock`, {
    method: "POST",
    body: { locked },
  });
  const idx = slots.value.findIndex((s) => s.id === slotId);
  if (idx >= 0) slots.value[idx] = updated;
}

async function removeSlot(slotId: number) {
  await $fetch(`/api/slots/${slotId}`, { method: "DELETE" }).catch(() => {
    // DELETE might not exist yet, remove locally
  });
  slots.value = slots.value.filter((s) => s.id !== slotId);
}

function repoName(repoId: number): string {
  const repo = repos.value.find((r) => r.id === repoId);
  return repo ? (repo.org ? `${repo.org}/${repo.name}` : repo.name) : `Repo #${repoId}`;
}

onMounted(fetchData);
</script>

<template>
  <div>
    <!-- Header -->
    <div class="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h2 class="font-display text-lg font-bold text-zinc-100">Workspace Slots</h2>
        <p class="text-xs text-zinc-500">Manage workspace directories for agent execution</p>
      </div>
      <button
        class="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-700"
        @click="showAddForm = !showAddForm"
      >
        {{ showAddForm ? "✕ Cancel" : "+ Add Slot" }}
      </button>
    </div>

    <!-- Scan paths -->
    <div
      v-if="repoPaths.length && !editingPaths"
      class="mb-4 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2"
    >
      <span class="text-[11px] font-medium text-zinc-500">Scan paths:</span>
      <span class="flex-1 truncate font-mono text-[11px] text-zinc-400">
        {{ repoPaths.join(", ") }}
      </span>
      <button
        class="shrink-0 text-[11px] font-medium text-blue-400 hover:underline"
        @click="startEditingPaths"
      >
        Edit
      </button>
    </div>

    <!-- Edit scan paths -->
    <div v-if="editingPaths" class="mb-4 rounded-lg border border-zinc-700 bg-zinc-900/80 p-4">
      <label class="mb-1 block text-[11px] font-medium uppercase tracking-wider text-zinc-400">
        Repo Scan Directories
      </label>
      <textarea
        v-model="editPathInput"
        rows="3"
        placeholder="One path per line"
        class="mb-2 w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-200 placeholder-zinc-600 focus:border-blue-500 focus:outline-none"
      />
      <div class="flex justify-end gap-2">
        <button
          class="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-700"
          @click="editingPaths = false"
        >
          Cancel
        </button>
        <button
          class="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-500"
          @click="savePaths"
        >
          Save
        </button>
      </div>
    </div>

    <!-- Add form -->
    <div v-if="showAddForm" class="mb-6 rounded-lg border border-zinc-700 bg-zinc-900/80 p-4">
      <div
        v-if="repos.length === 0"
        class="mb-4 rounded-lg border border-amber-900 bg-amber-950/50 px-3 py-2 text-xs text-amber-400"
      >
        No repos registered yet. Add your first slot below — the repo will be registered
        automatically from the directory's git remote.
      </div>
      <div class="grid gap-4 sm:grid-cols-2">
        <div>
          <label class="mb-1 block text-[11px] font-medium uppercase tracking-wider text-zinc-400"
            >Repository</label
          >
          <select
            v-model.number="form.repoId"
            class="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:border-blue-500 focus:outline-none"
          >
            <option :value="0" disabled>Select repo...</option>
            <option v-for="repo in repos" :key="repo.id" :value="repo.id">
              {{ repo.org ? `${repo.org}/` : "" }}{{ repo.name }}
            </option>
          </select>
        </div>
        <div>
          <label class="mb-1 block text-[11px] font-medium uppercase tracking-wider text-zinc-400"
            >Absolute Path</label
          >
          <input
            v-model="form.path"
            type="text"
            placeholder="/home/user/code/my-app"
            class="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-200 placeholder-zinc-600 focus:border-blue-500 focus:outline-none"
          />
          <p class="mt-1 text-[11px] text-zinc-600">
            Full path to a git checkout where the agent will execute.
          </p>
        </div>
        <div>
          <label class="mb-1 block text-[11px] font-medium uppercase tracking-wider text-zinc-400"
            >Port Config (JSON)
            <span class="normal-case tracking-normal font-normal text-zinc-600">— optional</span>
          </label>
          <input
            v-model="form.portConfig"
            type="text"
            placeholder='{"web": 3003, "db": 5435}'
            class="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-200 placeholder-zinc-600 focus:border-blue-500 focus:outline-none"
          />
          <p class="mt-1 text-[11px] text-zinc-600">
            Named ports for the agent's dev server. Avoids port conflicts between slots.
          </p>
        </div>
        <div>
          <label class="mb-1 block text-[11px] font-medium uppercase tracking-wider text-zinc-400"
            >.env Path
            <span class="normal-case tracking-normal font-normal text-zinc-600">— optional</span>
          </label>
          <input
            v-model="form.envPath"
            type="text"
            placeholder="/home/user/code/my-app/.env"
            class="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-200 placeholder-zinc-600 focus:border-blue-500 focus:outline-none"
          />
          <p class="mt-1 text-[11px] text-zinc-600">
            Path to .env file loaded into the agent's shell environment.
          </p>
        </div>
      </div>
      <div class="mt-4 flex justify-end">
        <button
          :disabled="!form.repoId || !form.path"
          class="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
          @click="addSlot"
        >
          Add Slot
        </button>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex items-center justify-center py-12">
      <span
        class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-blue-400"
      />
    </div>

    <!-- Slot grid -->
    <div v-else-if="slots.length" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <WorkspaceSlotCard
        v-for="s in slots"
        :key="s.id"
        :slot="s"
        :repo-name="repoName(s.repoId)"
        @lock="toggleLock"
        @remove="removeSlot"
      />
    </div>

    <!-- Empty state -->
    <div v-else class="rounded-lg border border-dashed border-zinc-800 py-12 text-center">
      <p class="text-sm text-zinc-400">No workspace slots configured</p>
      <p class="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-zinc-600">
        Workspace slots are directories where agents execute work. Each slot maps to a repo
        checkout. Click "+ Add Slot" above to register your first workspace.
      </p>
    </div>
  </div>
</template>
