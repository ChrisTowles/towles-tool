<script setup lang="ts">
const props = defineProps<{
  steps: string[];
  currentStepId: string | null;
  retryCount: number;
}>();

const stepStates = computed(() => {
  if (!props.steps.length) return [];

  const currentIdx = props.currentStepId ? props.steps.indexOf(props.currentStepId) : -1;

  return props.steps.map((stepId, idx) => {
    let state: "completed" | "current" | "pending";
    if (currentIdx < 0) {
      state = "pending";
    } else if (idx < currentIdx) {
      state = "completed";
    } else if (idx === currentIdx) {
      state = "current";
    } else {
      state = "pending";
    }
    return { stepId, state };
  });
});
</script>

<template>
  <div v-if="steps.length" class="flex items-center gap-1">
    <span
      v-for="step in stepStates"
      :key="step.stepId"
      class="text-xs leading-none"
      :class="{
        'text-emerald-400': step.state === 'completed',
        'text-blue-400 animate-pulse': step.state === 'current',
        'text-zinc-600': step.state === 'pending',
      }"
      :title="step.stepId"
    >
      {{ step.state === "completed" ? "◉" : step.state === "current" ? "◎" : "○" }}
    </span>
    <span
      v-if="retryCount > 0"
      class="ml-1 rounded bg-amber-500/20 px-1 py-px text-[9px] font-mono font-semibold text-amber-400"
    >
      ↻{{ retryCount }}
    </span>
  </div>
</template>
