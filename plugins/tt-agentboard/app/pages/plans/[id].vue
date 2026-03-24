<script setup lang="ts">
import type { Card } from "~/composables/useCards";
import type { CardStatus } from "~/utils/constants";
import { STATUS_DOT_CLASSES, PR_GRANULARITY_LABELS } from "~/utils/constants";

interface Plan {
  id: number;
  name: string;
  description: string | null;
  prGranularity: string;
  cards: Card[];
}

const route = useRoute();
const planId = Number(route.params.id);

const { data: plan, refresh } = await useFetch<Plan>(`/api/plans/${planId}`);

// Parse dependsOn JSON for each card
function getDeps(card: Card): number[] {
  if (!card.dependsOn) return [];
  try {
    return JSON.parse(card.dependsOn) as number[];
  } catch {
    return [];
  }
}

// Layout cards in DAG layers using topological sort
const dagLayout = computed(() => {
  if (!plan.value?.cards.length)
    return { layers: [] as Card[][], positions: new Map<number, { col: number; row: number }>() };

  const cardsMap = new Map(plan.value.cards.map((c) => [c.id, c]));
  const deps = new Map(plan.value.cards.map((c) => [c.id, getDeps(c)]));

  // Compute layer for each card (longest path from root)
  const layers: Card[][] = [];
  const cardLayer = new Map<number, number>();

  function computeLayer(id: number, visited: Set<number>): number {
    if (cardLayer.has(id)) return cardLayer.get(id)!;
    if (visited.has(id)) return 0; // cycle guard
    visited.add(id);

    const cardDeps = deps.get(id) ?? [];
    const layer =
      cardDeps.length === 0 ? 0 : Math.max(...cardDeps.map((d) => computeLayer(d, visited) + 1));

    cardLayer.set(id, layer);
    return layer;
  }

  for (const card of plan.value.cards) {
    computeLayer(card.id, new Set());
  }

  // Group cards into layers
  for (const card of plan.value.cards) {
    const layer = cardLayer.get(card.id) ?? 0;
    if (!layers[layer]) layers[layer] = [];
    layers[layer]!.push(card);
  }

  // Build position map
  const positions = new Map<number, { col: number; row: number }>();
  for (let col = 0; col < layers.length; col++) {
    const layer = layers[col]!;
    for (let row = 0; row < layer.length; row++) {
      positions.set(layer[row]!.id, { col, row });
    }
  }

  return { layers, positions };
});

// SVG edge lines
const CARD_W = 220;
const CARD_H = 80;
const GAP_X = 100;
const GAP_Y = 30;

function cardX(col: number) {
  return col * (CARD_W + GAP_X);
}
function cardY(row: number) {
  return row * (CARD_H + GAP_Y);
}

const edges = computed(() => {
  if (!plan.value?.cards) return [];
  const { positions } = dagLayout.value;
  const result: { x1: number; y1: number; x2: number; y2: number }[] = [];

  for (const card of plan.value.cards) {
    const to = positions.get(card.id);
    if (!to) continue;
    for (const depId of getDeps(card)) {
      const from = positions.get(depId);
      if (!from) continue;
      result.push({
        x1: cardX(from.col) + CARD_W,
        y1: cardY(from.row) + CARD_H / 2,
        x2: cardX(to.col),
        y2: cardY(to.row) + CARD_H / 2,
      });
    }
  }
  return result;
});

const svgWidth = computed(() => {
  const maxCol = dagLayout.value.layers.length;
  return maxCol * (CARD_W + GAP_X) + 40;
});

const svgHeight = computed(() => {
  const maxRows = Math.max(1, ...dagLayout.value.layers.map((l) => l.length));
  return maxRows * (CARD_H + GAP_Y) + 40;
});

const statusColors: Record<CardStatus, string> = {
  idle: "bg-zinc-800 border-zinc-600",
  queued: "bg-zinc-800 border-zinc-500",
  running: "bg-blue-950 border-blue-500",
  waiting_input: "bg-amber-950 border-amber-400",
  review_ready: "bg-emerald-950 border-emerald-500",
  done: "bg-emerald-950 border-emerald-500",
  failed: "bg-red-950 border-red-500",
  blocked: "bg-zinc-900 border-zinc-700",
};

// Auto-refresh
const refreshInterval = ref<ReturnType<typeof setInterval> | null>(null);
onMounted(() => {
  refreshInterval.value = setInterval(refresh, 5000);
});
onUnmounted(() => {
  if (refreshInterval.value) clearInterval(refreshInterval.value);
});
</script>

<template>
  <div class="min-h-screen bg-zinc-950">
    <!-- Nav -->
    <nav class="border-b border-zinc-800 px-4 py-3 sm:px-6">
      <div class="flex items-center gap-4">
        <NuxtLink
          to="/"
          class="text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200"
        >
          ← Board
        </NuxtLink>
        <span class="text-zinc-700">│</span>
        <NuxtLink
          to="/plans"
          class="text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200"
        >
          Plans
        </NuxtLink>
        <template v-if="plan">
          <span class="text-zinc-700">│</span>
          <span class="text-sm font-semibold text-zinc-200">{{ plan.name }}</span>
        </template>
      </div>
    </nav>

    <div class="p-4 sm:p-6">
    <!-- Header -->
    <div class="mb-6 flex items-center gap-4">
      <template v-if="plan">
        <h1 class="text-lg font-bold text-zinc-100">{{ plan.name }}</h1>
        <span class="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
          {{ plan.cards.length }} cards
        </span>
        <span class="rounded bg-zinc-800 px-2 py-0.5 text-xs font-mono text-zinc-500">
          {{ PR_GRANULARITY_LABELS[plan.prGranularity] ?? plan.prGranularity }}
        </span>
      </template>
    </div>

    <p v-if="plan?.description" class="mb-6 max-w-2xl text-sm text-zinc-400">
      {{ plan.description }}
    </p>

    <!-- DAG View -->
    <div
      v-if="plan?.cards.length"
      class="overflow-auto rounded-lg border border-zinc-800 bg-zinc-900 p-5"
    >
      <div class="relative" :style="{ width: svgWidth + 'px', height: svgHeight + 'px' }">
        <!-- SVG edges -->
        <svg class="pointer-events-none absolute inset-0" :width="svgWidth" :height="svgHeight">
          <line
            v-for="(edge, i) in edges"
            :key="i"
            :x1="edge.x1 + 20"
            :y1="edge.y1 + 20"
            :x2="edge.x2 + 20"
            :y2="edge.y2 + 20"
            stroke="#52525b"
            stroke-width="2"
            stroke-dasharray="6 4"
          />
          <!-- Arrowheads -->
          <polygon
            v-for="(edge, i) in edges"
            :key="'arrow-' + i"
            :points="`${edge.x2 + 20},${edge.y2 + 20} ${edge.x2 + 12},${edge.y2 + 14} ${edge.x2 + 12},${edge.y2 + 26}`"
            fill="#52525b"
          />
        </svg>

        <!-- Card nodes -->
        <div
          v-for="card in plan.cards"
          :key="card.id"
          class="absolute rounded-lg border-2 px-3 py-2"
          :class="statusColors[card.status as CardStatus] ?? 'bg-zinc-800 border-zinc-600'"
          :style="{
            left: cardX(dagLayout.positions.get(card.id)?.col ?? 0) + 20 + 'px',
            top: cardY(dagLayout.positions.get(card.id)?.row ?? 0) + 20 + 'px',
            width: CARD_W + 'px',
            height: CARD_H + 'px',
          }"
        >
          <div class="flex items-center gap-2">
            <span
              class="h-2 w-2 shrink-0 rounded-full"
              :class="STATUS_DOT_CLASSES[card.status as CardStatus] ?? 'bg-zinc-500'"
            />
            <span class="text-xs font-mono text-zinc-500">#{{ card.id }}</span>
          </div>
          <p class="mt-1 text-sm font-medium text-zinc-200 line-clamp-2">{{ card.title }}</p>
        </div>
      </div>
    </div>

    <div v-else class="py-20 text-center">
      <p class="text-sm text-zinc-400">No cards in this plan yet</p>
      <p class="mt-1 text-xs text-zinc-600">
        Create cards and assign them to this plan to build your dependency graph
      </p>
    </div>
    </div>
  </div>
</template>
