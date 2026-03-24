<script setup lang="ts">
defineProps<{
  name: string;
  org?: string | null;
}>();
</script>

<template>
  <span
    class="inline-flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-mono text-zinc-400"
  >
    <svg
      class="h-3 w-3 text-zinc-500"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      stroke-width="2"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
      />
    </svg>
    <span v-if="org" class="text-zinc-500">{{ org }}/</span>{{ name }}
  </span>
</template>
