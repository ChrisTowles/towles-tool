<script setup lang="ts">
import type { CardStatus } from "~/utils/constants";
import { STATUS_LABELS, STATUS_DOT_CLASSES } from "~/utils/constants";

const props = defineProps<{
  status: CardStatus;
}>();

const dotClass = computed(() => STATUS_DOT_CLASSES[props.status] ?? "bg-zinc-500");
const label = computed(() => STATUS_LABELS[props.status] ?? props.status);
const isAnimated = computed(() => props.status === "running");
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-zinc-400"
  >
    <span class="relative flex h-2 w-2">
      <span
        v-if="isAnimated"
        class="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
        :class="dotClass"
      />
      <span class="relative inline-flex h-2 w-2 rounded-full" :class="dotClass" />
    </span>
    {{ label }}
  </span>
</template>
