import { COLUMNS } from "~/utils/constants";
import type { Column } from "~/utils/constants";
import type { Card } from "~/composables/useCards";

export function useBoard(cards: Ref<Card[]>) {
  const columnCards = computed(() => {
    const grouped: Record<Column, Card[]> = {
      backlog: [],
      ready: [],
      in_progress: [],
      review: [],
      done: [],
    };

    for (const card of cards.value) {
      const col = card.column as Column;
      if (grouped[col]) {
        grouped[col].push(card);
      }
    }

    for (const col of COLUMNS) {
      grouped[col].sort((a, b) => a.position - b.position);
    }

    return grouped;
  });

  const columnCounts = computed(() => {
    const counts: Record<Column, number> = {
      backlog: 0,
      ready: 0,
      in_progress: 0,
      review: 0,
      done: 0,
    };
    for (const col of COLUMNS) {
      counts[col] = columnCards.value[col].length;
    }
    return counts;
  });

  const totalCards = computed(() => cards.value.length);
  const activeCards = computed(() => cards.value.filter((c) => c.status === "running").length);

  return { columnCards, columnCounts, totalCards, activeCards };
}
