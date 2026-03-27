<script setup lang="ts">
const props = defineProps<{
  name: string;
  org?: string | null;
  repoId?: number | null;
}>();

const PALETTE = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-violet-500",
  "bg-cyan-500",
  "bg-pink-500",
  "bg-lime-500",
  "bg-orange-500",
  "bg-teal-500",
  "bg-indigo-500",
  "bg-fuchsia-500",
];

const colorClass = computed(() => {
  if (props.repoId != null) {
    return PALETTE[props.repoId % PALETTE.length];
  }
  const str = `${props.org ?? ""}/${props.name}`;
  const hash = [...str].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return PALETTE[hash % PALETTE.length];
});
</script>

<template>
  <span
    class="inline-flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-mono text-zinc-400"
  >
    <span class="h-2 w-2 shrink-0 rounded-full" :class="colorClass" />
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
