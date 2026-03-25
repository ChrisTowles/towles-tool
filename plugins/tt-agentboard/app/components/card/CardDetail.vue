<script setup lang="ts">
import type { Card } from "~/composables/useCards";
import type { CardStatus } from "~/utils/constants";
import { COLUMN_LABELS, EXECUTION_MODE_LABELS } from "~/utils/constants";

const props = defineProps<{
  card: Card;
  compact?: boolean;
}>();

const emit = defineEmits<{
  archive: [];
  respond: [response: string];
}>();

const agentInput = ref("");

const branchUrl = computed(() => {
  if (!props.card.branch) return null;
  if (props.card.repo?.githubUrl) {
    return `${props.card.repo.githubUrl}/tree/${props.card.branch}`;
  }
  if (props.card.repo?.org && props.card.repo?.name) {
    return `https://github.com/${props.card.repo.org}/${props.card.repo.name}/tree/${props.card.branch}`;
  }
  return null;
});

const issueUrl = computed(() => {
  if (!props.card.githubIssueNumber) return null;
  if (props.card.repo?.githubUrl) {
    return `${props.card.repo.githubUrl}/issues/${props.card.githubIssueNumber}`;
  }
  if (props.card.repo?.org && props.card.repo?.name) {
    return `https://github.com/${props.card.repo.org}/${props.card.repo.name}/issues/${props.card.githubIssueNumber}`;
  }
  return null;
});

const prUrl = computed(() => {
  if (!props.card.githubPrNumber) return null;
  if (props.card.repo?.githubUrl) {
    return `${props.card.repo.githubUrl}/pull/${props.card.githubPrNumber}`;
  }
  if (props.card.repo?.org && props.card.repo?.name) {
    return `https://github.com/${props.card.repo.org}/${props.card.repo.name}/pull/${props.card.githubPrNumber}`;
  }
  return null;
});

function sendResponse() {
  if (!agentInput.value.trim()) return;
  emit("respond", agentInput.value);
  agentInput.value = "";
}
</script>

<template>
  <div>
    <h2 class="font-bold text-zinc-100" :class="compact ? 'mb-1 text-sm' : 'mb-2 text-lg'">
      <span class="font-mono text-zinc-500">#{{ card.id }}</span>
      {{ card.title }}
    </h2>

    <div class="mb-4 flex flex-wrap items-center gap-2">
      <SharedStatusBadge :status="card.status as CardStatus" />
      <span class="rounded bg-zinc-800 px-2 py-0.5 text-[10px] font-mono uppercase text-zinc-400">
        {{ COLUMN_LABELS[card.column] }}
      </span>
      <span v-if="!compact" class="text-[10px] font-mono text-zinc-500">
        {{ EXECUTION_MODE_LABELS[card.executionMode] ?? card.executionMode }}
      </span>
    </div>

    <p
      v-if="card.description"
      class="mb-4 text-zinc-400"
      :class="compact ? 'text-xs leading-relaxed line-clamp-3' : 'text-sm leading-relaxed'"
    >
      {{ card.description }}
    </p>

    <div v-if="card.repo && !compact" class="mb-4">
      <SharedRepoBadge :name="card.repo.name" :org="card.repo.org" />
    </div>

    <div
      v-if="(card.githubIssueNumber || card.githubPrNumber || card.branch) && !compact"
      class="mb-4 space-y-1.5"
    >
      <!-- Branch -->
      <div v-if="card.branch" class="flex items-center gap-1.5 text-xs font-mono">
        <span class="text-zinc-600">branch</span>
        <a
          v-if="branchUrl"
          :href="branchUrl"
          target="_blank"
          class="rounded bg-zinc-800 px-1.5 py-0.5 text-blue-400 hover:text-blue-300 hover:underline"
        >
          {{ card.branch }}
        </a>
        <span v-else class="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">{{ card.branch }}</span>
      </div>

      <!-- Issue + PR row -->
      <div
        v-if="card.githubIssueNumber || card.githubPrNumber"
        class="flex items-center gap-2 text-xs font-mono text-zinc-500"
      >
        <template v-if="card.githubIssueNumber">
          <span>Issue</span>
          <a
            v-if="issueUrl"
            :href="issueUrl"
            target="_blank"
            class="text-blue-400 hover:text-blue-300 hover:underline"
          >
            #{{ card.githubIssueNumber }}
          </a>
          <span v-else>#{{ card.githubIssueNumber }}</span>
        </template>
        <template v-if="card.githubPrNumber">
          <span v-if="card.githubIssueNumber">·</span>
          <span>PR</span>
          <a
            v-if="prUrl"
            :href="prUrl"
            target="_blank"
            class="rounded-full bg-purple-500/15 px-1.5 py-0.5 text-purple-400 hover:bg-purple-500/25 hover:underline"
          >
            #{{ card.githubPrNumber }}
          </a>
          <span v-else>#{{ card.githubPrNumber }}</span>
        </template>
      </div>
    </div>

    <!-- Timestamps + branch mode -->
    <div v-if="!compact" class="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-mono text-zinc-500">
      <span>Created {{ new Date(card.createdAt).toLocaleString() }}</span>
      <span>Updated {{ new Date(card.updatedAt).toLocaleString() }}</span>
    </div>

    <!-- Archive button -->
    <button
      v-if="card.status === 'review_ready'"
      class="mb-4 rounded-lg border border-emerald-600 bg-emerald-600/10 px-3 py-1.5 text-xs font-semibold text-emerald-400 transition-colors hover:bg-emerald-600/20"
      @click="emit('archive')"
    >
      ✓ Archive
    </button>

    <!-- Agent question input -->
    <div
      v-if="card.status === 'waiting_input'"
      class="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
    >
      <p class="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-400">
        Agent needs input
      </p>
      <div class="flex gap-2">
        <input
          v-model="agentInput"
          type="text"
          placeholder="Type your response..."
          class="flex-1 rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 focus:border-amber-500 focus:outline-none"
          @keyup.enter="sendResponse"
        />
        <button
          class="rounded bg-amber-500 px-3 py-2 text-xs font-semibold text-zinc-900 transition-colors hover:bg-amber-400"
          @click="sendResponse"
        >
          Send
        </button>
      </div>
    </div>
  </div>
</template>
