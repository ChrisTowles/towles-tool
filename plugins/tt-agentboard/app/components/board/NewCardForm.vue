<script setup lang="ts">
interface Repo {
  id: number;
  name: string;
  org: string | null;
}

const emit = defineEmits<{
  created: [];
  cancel: [];
}>();

const title = ref("");
const description = ref("");
const repoId = ref<number | undefined>(undefined);
const workflowId = ref<string | undefined>(undefined);
const executionMode = ref<"headless" | "interactive">("headless");
const submitting = ref(false);

const { data: repos } = useFetch<Repo[]>("/api/repos");
const { createCard } = useCards();

async function submit() {
  if (!title.value.trim() || submitting.value) return;
  submitting.value = true;
  const card = await createCard({
    title: title.value.trim(),
    description: description.value.trim() || undefined,
    repoId: repoId.value,
    workflowId: workflowId.value || undefined,
  });
  submitting.value = false;
  if (card) {
    title.value = "";
    description.value = "";
    repoId.value = undefined;
    workflowId.value = undefined;
    executionMode.value = "headless";
    emit("created");
  }
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-20" @click.self="emit('cancel')">
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
        <!-- Title -->
        <div>
          <label class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
            Title <span class="text-red-400">*</span>
          </label>
          <input
            v-model="title"
            type="text"
            placeholder="What needs to be done?"
            autofocus
            class="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
          />
        </div>

        <!-- Description -->
        <div>
          <label class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
            Description
          </label>
          <textarea
            v-model="description"
            rows="3"
            placeholder="Optional details, context, or instructions..."
            class="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
          />
        </div>

        <!-- Repo selector -->
        <div>
          <label class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
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
        </div>

        <!-- Execution mode toggle -->
        <div>
          <label class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
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
            :disabled="!title.trim() || submitting"
            class="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {{ submitting ? "Creating..." : "Create Card" }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
