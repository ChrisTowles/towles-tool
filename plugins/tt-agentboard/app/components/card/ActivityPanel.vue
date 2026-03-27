<script setup lang="ts">
import type { AgentActivityEvent } from "~/composables/useWebSocket";

const props = defineProps<{ cardId: number }>();

type ActivityEvent =
  | {
      kind: "tool_use";
      name: string;
      detail: string;
      input: Record<string, unknown>;
      timestamp: number;
    }
  | { kind: "thinking"; summary: string; timestamp: number }
  | { kind: "text"; content: string; timestamp: number }
  | {
      kind: "result";
      costUsd: number;
      durationMs: number;
      numTurns: number;
      isError: boolean;
      timestamp: number;
    };

const MAX_EVENTS = 500;
const events = ref<ActivityEvent[]>([]);
const container = ref<HTMLElement>();
const autoScroll = ref(true);

const { on, off, subscribeActivity, unsubscribeActivity } = useWebSocket();

function handleActivity(raw: { type: string; [key: string]: unknown }) {
  const evt = raw as unknown as AgentActivityEvent;
  if (evt.cardId !== props.cardId) return;

  const activity: ActivityEvent = {
    ...evt.event,
    timestamp: evt.timestamp,
  };

  events.value.push(activity);
  if (events.value.length > MAX_EVENTS) {
    events.value = events.value.slice(-MAX_EVENTS);
  }

  if (autoScroll.value) {
    nextTick(() => {
      container.value?.scrollTo({ top: container.value.scrollHeight });
    });
  }
}

function handleScroll() {
  if (!container.value) return;
  const { scrollTop, scrollHeight, clientHeight } = container.value;
  autoScroll.value = scrollHeight - scrollTop - clientHeight < 40;
}

onMounted(() => {
  subscribeActivity(props.cardId);
  on("agent:activity", handleActivity);
});

onUnmounted(() => {
  off("agent:activity", handleActivity);
  unsubscribeActivity(props.cardId);
});
</script>

<template>
  <div ref="container" class="h-full overflow-y-auto p-4 space-y-2" @scroll="handleScroll">
    <div v-if="events.length === 0" class="text-zinc-500 text-sm">
      Waiting for agent activity...
    </div>
    <div v-for="(event, i) in events" :key="i" class="text-sm">
      <!-- Tool use -->
      <div v-if="event.kind === 'tool_use'" class="flex items-start gap-2 py-1">
        <span class="text-blue-400 font-mono text-xs shrink-0">▶</span>
        <span class="font-mono text-blue-300">{{ event.name }}</span>
        <span class="text-zinc-500 truncate">{{ event.detail }}</span>
      </div>
      <!-- Thinking -->
      <div v-else-if="event.kind === 'thinking'" class="py-1 text-zinc-500 italic truncate">
        {{ event.summary }}
      </div>
      <!-- Text output -->
      <div v-else-if="event.kind === 'text'" class="py-1 text-zinc-300">
        {{ event.content }}
      </div>
      <!-- Result -->
      <div v-else-if="event.kind === 'result'" class="py-2 border-t border-zinc-700 mt-2">
        <span :class="event.isError ? 'text-red-400' : 'text-emerald-400'">
          {{ event.isError ? "Failed" : "Completed" }}
        </span>
        <span class="text-zinc-500 ml-2">
          {{ event.numTurns }} turns · ${{ event.costUsd?.toFixed(4) }}
        </span>
      </div>
    </div>
  </div>
</template>
