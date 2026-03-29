<script setup lang="ts">
import type { Column } from "~/utils/constants";
import { COLUMN_LABELS, COLUMN_ICONS } from "~/utils/constants";
import type { Card } from "~/stores/cards";

const props = defineProps<{
  column: Column;
  cards: Card[];
}>();

const emit = defineEmits<{
  cardMoved: [cardId: number, column: Column, position: number];
  cardSelected: [cardId: number];
  clearDone: [];
}>();

const label = computed(() => COLUMN_LABELS[props.column]);
const icon = computed(() => COLUMN_ICONS[props.column]);

const columnClasses: Record<Column, string> = {
  ready: "border-t-cyan-500",
  in_progress: "border-t-blue-500",
  simplify_review: "border-t-purple-500",
  review: "border-t-violet-500",
  done: "border-t-emerald-500",
  archived: "border-t-zinc-600",
};

// Animate count badge on change
const countBounce = ref(false);
watch(
  () => props.cards.length,
  () => {
    countBounce.value = true;
    setTimeout(() => {
      countBounce.value = false;
    }, 300);
  },
);

function onDragChange(evt: { added?: { element: { id: number }; newIndex: number } }) {
  // Only handle 'added' — fires on the DESTINATION column when a card is dropped in
  if (evt.added) {
    emit("cardMoved", evt.added.element.id, props.column, evt.added.newIndex);
  }
}
</script>

<template>
  <div
    class="flex min-w-[280px] flex-col rounded-xl border border-zinc-800 border-t-2 bg-zinc-900/50 backdrop-blur-sm"
    :class="columnClasses[column]"
  >
    <!-- Column header -->
    <div class="flex items-center justify-between px-4 py-3">
      <div class="flex items-center gap-2">
        <span class="text-sm opacity-60">{{ icon }}</span>
        <span class="text-xs font-semibold uppercase tracking-widest text-zinc-300">{{
          label
        }}</span>
      </div>
      <div class="flex items-center gap-2">
        <span
          class="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] font-mono font-bold tabular-nums text-zinc-400 transition-transform duration-300"
          :class="countBounce ? 'scale-125' : 'scale-100'"
        >
          {{ cards.length }}
        </span>
        <button
          v-if="column === 'done' && cards.length > 0"
          class="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
          title="Clear all done cards"
          @click="emit('clearDone')"
        >
          Clear
        </button>
      </div>
    </div>

    <!-- Card list -->
    <div class="flex-1 space-y-2 overflow-y-auto px-3 pb-3" style="max-height: calc(100vh - 180px)">
      <ClientOnly>
        <draggable
          :model-value="cards"
          :group="{ name: 'cards', pull: true, put: true }"
          item-key="id"
          ghost-class="opacity-30"
          drag-class="rotate-2"
          :animation="200"
          @change="onDragChange"
        >
          <template #item="{ element }">
            <div :data-card-id="element.id">
              <BoardKanbanCard
                :card="element"
                @selected="(id: number) => emit('cardSelected', id)"
              />
            </div>
          </template>
        </draggable>
        <template #fallback>
          <div v-for="card in cards" :key="card.id">
            <BoardKanbanCard :card="card" @selected="(id: number) => emit('cardSelected', id)" />
          </div>
        </template>
      </ClientOnly>

      <!-- Empty state -->
      <div
        v-if="cards.length === 0"
        class="flex flex-col items-center justify-center rounded-lg border border-dashed border-zinc-800 py-8 text-center"
      >
        <p class="text-xs text-zinc-600">
          Drop cards here
        </p>
      </div>
    </div>
  </div>
</template>
