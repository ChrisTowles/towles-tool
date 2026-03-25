<script setup lang="ts">
interface DiscoveredRepo {
  path: string;
  name: string;
  org: string | null;
  githubUrl: string | null;
  alreadyRegistered: boolean;
}

interface RegisteredRepo {
  id: number;
  name: string;
  org: string | null;
  path: string;
  portConfig: string;
  envPath: string;
}

const emit = defineEmits<{
  complete: [];
}>();

const step = ref(1);
const scanning = ref(false);
const registering = ref(false);
const creatingSlots = ref(false);

// Step 1: Repo paths
const pathInput = ref("");
const repoPaths = ref<string[]>([]);

// Step 2: Discover
const discoveredRepos = ref<DiscoveredRepo[]>([]);
const selectedPaths = ref<Set<string>>(new Set());

// Step 3: Slot config
const registeredRepos = ref<RegisteredRepo[]>([]);

// Load saved paths on mount
onMounted(async () => {
  try {
    const config = await $fetch<{ repoPaths: string[] }>("/api/config");
    if (config.repoPaths.length > 0) {
      repoPaths.value = config.repoPaths;
    }
  } catch {
    // No config yet
  }
});

function addPath() {
  const p = pathInput.value.trim();
  if (p && !repoPaths.value.includes(p)) {
    repoPaths.value.push(p);
  }
  pathInput.value = "";
}

function removePath(idx: number) {
  repoPaths.value.splice(idx, 1);
}

function handlePathKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    addPath();
  }
}

async function savePathsAndScan() {
  // Save to config
  await $fetch("/api/config", {
    method: "PUT",
    body: { repoPaths: repoPaths.value },
  });

  // Move to step 2 and scan
  step.value = 2;
  scanning.value = true;
  try {
    const data = await $fetch<{ repos: DiscoveredRepo[] }>("/api/repos/discover");
    discoveredRepos.value = data.repos;
    selectedPaths.value = new Set(
      data.repos.filter((r) => !r.alreadyRegistered).map((r) => r.path),
    );
  } finally {
    scanning.value = false;
  }
}

function toggleRepo(path: string) {
  const repo = discoveredRepos.value.find((r) => r.path === path);
  if (repo?.alreadyRegistered) return;
  if (selectedPaths.value.has(path)) {
    selectedPaths.value.delete(path);
  } else {
    selectedPaths.value.add(path);
  }
}

function toggleAll() {
  const unregistered = discoveredRepos.value.filter((r) => !r.alreadyRegistered);
  if (selectedPaths.value.size === unregistered.length) {
    selectedPaths.value.clear();
  } else {
    selectedPaths.value = new Set(unregistered.map((r) => r.path));
  }
}

async function registerAndContinue() {
  registering.value = true;
  try {
    const toRegister = discoveredRepos.value.filter(
      (r) => selectedPaths.value.has(r.path) && !r.alreadyRegistered,
    );

    const results: RegisteredRepo[] = [];
    for (const repo of toRegister) {
      const created = await $fetch<{ id: number; name: string; org: string | null }>("/api/repos", {
        method: "POST",
        body: {
          name: repo.name,
          org: repo.org,
          githubUrl: repo.githubUrl,
        },
      });
      results.push({
        id: created.id,
        name: created.name,
        org: created.org,
        path: repo.path,
        portConfig: "",
        envPath: "",
      });
    }

    registeredRepos.value = results;
    step.value = 3;
  } finally {
    registering.value = false;
  }
}

async function createSlots() {
  creatingSlots.value = true;
  try {
    for (const repo of registeredRepos.value) {
      let portConfig = null;
      if (repo.portConfig.trim()) {
        try {
          portConfig = JSON.parse(repo.portConfig);
        } catch {
          continue;
        }
      }

      await $fetch("/api/slots", {
        method: "POST",
        body: {
          repoId: repo.id,
          path: repo.path,
          portConfig,
          envPath: repo.envPath || null,
        },
      });
    }

    emit("complete");
  } finally {
    creatingSlots.value = false;
  }
}

const selectedCount = computed(
  () =>
    discoveredRepos.value.filter((r) => selectedPaths.value.has(r.path) && !r.alreadyRegistered)
      .length,
);
</script>

<template>
  <div class="mx-auto max-w-2xl rounded-xl border border-zinc-800 bg-zinc-900/80 p-6">
    <!-- Progress steps -->
    <div class="mb-6 flex items-center justify-center gap-2">
      <template v-for="(label, idx) in ['Paths', 'Repos', 'Slots']" :key="idx">
        <div
          class="flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold"
          :class="
            idx + 1 < step
              ? 'bg-emerald-500/20 text-emerald-400'
              : idx + 1 === step
                ? 'bg-blue-500/20 text-blue-400'
                : 'bg-zinc-800 text-zinc-500'
          "
        >
          <span v-if="idx + 1 < step">&#10003;</span>
          <span v-else>{{ idx + 1 }}</span>
        </div>
        <span
          class="text-[10px] font-medium"
          :class="idx + 1 <= step ? 'text-zinc-300' : 'text-zinc-600'"
          >{{ label }}</span
        >
        <div
          v-if="idx < 2"
          class="h-px w-6"
          :class="idx + 1 < step ? 'bg-emerald-500/40' : 'bg-zinc-700'"
        />
      </template>
    </div>

    <!-- Step 1: Where are your repos? -->
    <div v-if="step === 1">
      <h2 class="mb-1 text-lg font-bold text-zinc-100">Where do you keep your repos?</h2>
      <p class="mb-4 text-xs text-zinc-500">
        Add the parent directories that contain your git repositories. We'll scan one level deep in
        each.
      </p>

      <div class="mb-3 flex gap-2">
        <input
          v-model="pathInput"
          type="text"
          placeholder="/home/user/code"
          class="flex-1 rounded border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-200 placeholder-zinc-600 focus:border-blue-500 focus:outline-none"
          @keydown="handlePathKeydown"
        />
        <button
          :disabled="!pathInput.trim()"
          class="shrink-0 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
          @click="addPath"
        >
          + Add
        </button>
      </div>

      <!-- Path list -->
      <div v-if="repoPaths.length" class="mb-4 space-y-1">
        <div
          v-for="(p, idx) in repoPaths"
          :key="p"
          class="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2"
        >
          <span class="truncate font-mono text-xs text-zinc-300">{{ p }}</span>
          <button
            class="ml-2 shrink-0 text-xs text-zinc-500 transition-colors hover:text-red-400"
            @click="removePath(idx)"
          >
            &#x2715;
          </button>
        </div>
      </div>

      <div v-else class="mb-4 rounded-lg border border-dashed border-zinc-800 py-6 text-center">
        <p class="text-xs text-zinc-500">
          No paths added yet. Type a directory path above and press Enter.
        </p>
      </div>

      <div class="flex justify-end">
        <button
          :disabled="repoPaths.length === 0"
          class="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
          @click="savePathsAndScan"
        >
          Next: Scan for Repos
        </button>
      </div>
    </div>

    <!-- Step 2: Discover repos -->
    <div v-if="step === 2">
      <h2 class="mb-1 text-lg font-bold text-zinc-100">Discovered Repositories</h2>
      <p class="mb-4 text-xs text-zinc-500">
        Select the repos you want to register with AgentBoard.
      </p>

      <!-- Scanning spinner -->
      <div v-if="scanning" class="flex items-center justify-center py-12">
        <div class="flex items-center gap-3 text-sm text-zinc-500">
          <span
            class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-blue-400"
          />
          Scanning directories...
        </div>
      </div>

      <template v-else>
        <div
          v-if="discoveredRepos.length === 0"
          class="rounded-lg border border-dashed border-zinc-700 py-8 text-center"
        >
          <p class="text-sm text-zinc-400">No git repos found in the configured directories.</p>
          <p class="mt-1 text-xs text-zinc-600">
            <button class="text-blue-400 hover:underline" @click="step = 1">
              Go back and add different paths.
            </button>
          </p>
        </div>

        <div v-else>
          <div class="mb-3 flex items-center justify-between">
            <p class="text-sm text-zinc-300">
              Found
              <span class="font-semibold text-blue-400">{{ discoveredRepos.length }}</span>
              git repos
            </p>
            <button
              class="text-[11px] font-medium text-zinc-400 hover:text-zinc-200"
              @click="toggleAll"
            >
              {{
                selectedPaths.size === discoveredRepos.filter((r) => !r.alreadyRegistered).length
                  ? "Deselect All"
                  : "Select All"
              }}
            </button>
          </div>

          <div
            class="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/50 p-2"
          >
            <div
              v-for="repo in discoveredRepos"
              :key="repo.path"
              class="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 transition-colors"
              :class="
                repo.alreadyRegistered
                  ? 'opacity-60'
                  : selectedPaths.has(repo.path)
                    ? 'bg-blue-500/10 border border-blue-500/20'
                    : 'hover:bg-zinc-800/50 border border-transparent'
              "
              @click="toggleRepo(repo.path)"
            >
              <div class="flex h-4 w-4 shrink-0 items-center justify-center">
                <span
                  v-if="repo.alreadyRegistered"
                  class="text-emerald-400"
                  title="Already registered"
                  >&#10003;</span
                >
                <span
                  v-else-if="selectedPaths.has(repo.path)"
                  class="flex h-4 w-4 items-center justify-center rounded border border-blue-500 bg-blue-500 text-[10px] text-white"
                  >&#10003;</span
                >
                <span
                  v-else
                  class="flex h-4 w-4 items-center justify-center rounded border border-zinc-600"
                />
              </div>

              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium text-zinc-200">
                    {{ repo.org ? `${repo.org}/` : "" }}{{ repo.name }}
                  </span>
                  <span
                    v-if="repo.alreadyRegistered"
                    class="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400"
                    >registered</span
                  >
                </div>
                <p class="truncate font-mono text-[11px] text-zinc-500">{{ repo.path }}</p>
              </div>
            </div>
          </div>

          <div class="mt-4 flex items-center justify-between">
            <button class="text-xs text-zinc-400 hover:text-zinc-200" @click="step = 1">
              ← Back
            </button>
            <button
              :disabled="selectedCount === 0 || registering"
              class="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
              @click="registerAndContinue"
            >
              {{ registering ? "Registering..." : `Register ${selectedCount} and Configure Slots` }}
            </button>
          </div>
        </div>
      </template>
    </div>

    <!-- Step 3: Configure slots -->
    <div v-if="step === 3">
      <h2 class="mb-1 text-lg font-bold text-zinc-100">Configure Workspace Slots</h2>
      <p class="mb-4 text-xs text-zinc-500">
        Each repo gets a workspace slot. Adjust port config or .env path if needed, or leave
        defaults.
      </p>

      <div class="max-h-80 space-y-3 overflow-y-auto">
        <div
          v-for="repo in registeredRepos"
          :key="repo.id"
          class="rounded-lg border border-zinc-800 bg-zinc-950/50 p-4"
        >
          <div class="mb-1 text-sm font-semibold text-zinc-200">
            {{ repo.org ? `${repo.org}/` : "" }}{{ repo.name }}
          </div>
          <div class="mb-3 font-mono text-[11px] text-zinc-500">{{ repo.path }}</div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div>
              <label
                class="mb-1 block text-[11px] font-medium uppercase tracking-wider text-zinc-400"
              >
                Port Config (JSON)
                <span class="normal-case tracking-normal font-normal text-zinc-600"
                  >-- optional</span
                >
              </label>
              <input
                v-model="repo.portConfig"
                type="text"
                :placeholder="`{&quot;web&quot;: 3003}`"
                class="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-200 placeholder-zinc-600 focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label
                class="mb-1 block text-[11px] font-medium uppercase tracking-wider text-zinc-400"
              >
                .env Path
                <span class="normal-case tracking-normal font-normal text-zinc-600"
                  >-- optional</span
                >
              </label>
              <input
                v-model="repo.envPath"
                type="text"
                :placeholder="`${repo.path}/.env`"
                class="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-200 placeholder-zinc-600 focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>
        </div>
      </div>

      <div class="mt-4 flex items-center justify-between">
        <button class="text-xs text-zinc-400 hover:text-zinc-200" @click="step = 2">← Back</button>
        <button
          :disabled="creatingSlots"
          class="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
          @click="createSlots"
        >
          {{ creatingSlots ? "Creating..." : "Create Slots and Finish" }}
        </button>
      </div>
    </div>
  </div>
</template>
