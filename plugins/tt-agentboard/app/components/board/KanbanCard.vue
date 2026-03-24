<script setup lang="ts">
import type { Card } from "~/composables/useCards";
import type { CardStatus } from "~/utils/constants";
import { STATUS_BORDER_CLASSES } from "~/utils/constants";

const props = defineProps<{
  card: Card;
  workflowSteps?: string[];
}>();

const emit = defineEmits<{
  selected: [cardId: number];
}>();

const borderClass = computed(
  () => STATUS_BORDER_CLASSES[props.card.status as CardStatus] ?? "border-zinc-700",
);

const elapsedTime = computed(() => {
  if (props.card.status !== "running") return null;
  const start = new Date(props.card.updatedAt).getTime();
  const now = Date.now();
  const seconds = Math.floor((now - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
});

const modeIcon = computed(() => (props.card.executionMode === "interactive" ? "⌨" : "⚡"));

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
</script>

<template>
  <div
    class="group block cursor-pointer rounded-lg border-l-[3px] bg-zinc-900/80 p-3 shadow-lg transition-all duration-200 hover:bg-zinc-800/90 hover:shadow-xl"
    :class="borderClass"
    @click.stop="emit('selected', card.id)"
  >
    <!-- Header: title + mode icon -->
    <div class="mb-2 flex items-start justify-between gap-2">
      <h3 class="text-sm font-semibold leading-snug text-zinc-100 group-hover:text-white">
        {{ card.title }}
      </h3>
      <span class="shrink-0 text-xs" :title="card.executionMode">{{ modeIcon }}</span>
    </div>

    <!-- Repo badge -->
    <div v-if="card.repo" class="mb-2">
      <SharedRepoBadge :name="card.repo.name" :org="card.repo.org" />
    </div>

    <!-- Progress bar -->
    <BoardCardProgressBar
      v-if="workflowSteps?.length"
      :steps="workflowSteps"
      :current-step-id="card.currentStepId"
      :retry-count="card.retryCount"
      class="mb-2"
    />

    <!-- Footer: status + elapsed time + issue # -->
    <div class="flex items-center justify-between">
      <SharedStatusBadge :status="card.status as CardStatus" />
      <div class="flex items-center gap-2">
        <span v-if="elapsedTime" class="text-[10px] font-mono tabular-nums text-zinc-500">
          {{ elapsedTime }}
        </span>
        <a
          v-if="card.githubIssueNumber && issueUrl"
          :href="issueUrl"
          target="_blank"
          class="text-[10px] font-mono text-zinc-500 hover:text-blue-400"
          @click.stop
        >
          #{{ card.githubIssueNumber }}
        </a>
        <span v-else-if="card.githubIssueNumber" class="text-[10px] font-mono text-zinc-500">
          #{{ card.githubIssueNumber }}
        </span>
        <a
          v-if="card.githubPrNumber && prUrl"
          :href="prUrl"
          target="_blank"
          class="rounded-full bg-purple-500/15 px-1.5 py-0.5 text-[9px] font-mono text-purple-400 hover:bg-purple-500/25"
          @click.stop
        >
          PR #{{ card.githubPrNumber }}
        </a>
        <span
          v-else-if="card.githubPrNumber"
          class="rounded-full bg-purple-500/15 px-1.5 py-0.5 text-[9px] font-mono text-purple-400"
        >
          PR #{{ card.githubPrNumber }}
        </span>
      </div>
    </div>
  </div>
</template>
