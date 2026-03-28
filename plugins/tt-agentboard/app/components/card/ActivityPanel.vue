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

/** Map tool names to display labels matching Claude Code TUI style */
const TOOL_ICONS: Record<string, { label: string; color: string }> = {
  Read: { label: "Read", color: "text-blue-400 border-blue-500/30 bg-blue-500/5" },
  Edit: { label: "Edit", color: "text-amber-400 border-amber-500/30 bg-amber-500/5" },
  Write: { label: "Write", color: "text-amber-400 border-amber-500/30 bg-amber-500/5" },
  Bash: { label: "Bash", color: "text-emerald-400 border-emerald-500/30 bg-emerald-500/5" },
  Glob: { label: "Glob", color: "text-cyan-400 border-cyan-500/30 bg-cyan-500/5" },
  Grep: { label: "Grep", color: "text-cyan-400 border-cyan-500/30 bg-cyan-500/5" },
  Agent: { label: "Agent", color: "text-purple-400 border-purple-500/30 bg-purple-500/5" },
  TodoWrite: { label: "TodoWrite", color: "text-violet-400 border-violet-500/30 bg-violet-500/5" },
  TaskCreate: {
    label: "TaskCreate",
    color: "text-violet-400 border-violet-500/30 bg-violet-500/5",
  },
  TaskUpdate: {
    label: "TaskUpdate",
    color: "text-violet-400 border-violet-500/30 bg-violet-500/5",
  },
  WebFetch: { label: "WebFetch", color: "text-sky-400 border-sky-500/30 bg-sky-500/5" },
  WebSearch: { label: "WebSearch", color: "text-sky-400 border-sky-500/30 bg-sky-500/5" },
};

function getToolStyle(name: string) {
  return (
    TOOL_ICONS[name] ?? { label: name, color: "text-zinc-400 border-zinc-600/30 bg-zinc-800/50" }
  );
}

function formatDetail(event: ActivityEvent & { kind: "tool_use" }) {
  const input = event.input;
  if (!input) return event.detail;

  const filePath = input.file_path ?? input.path;
  if (typeof filePath === "string") return filePath;
  if (typeof input.command === "string") return input.command;
  if (typeof input.pattern === "string") return input.pattern;
  if (typeof input.subject === "string") return input.subject;
  return event.detail;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
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
  <div
    ref="container"
    class="h-full overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 font-mono text-[13px]"
    @scroll="handleScroll"
  >
    <!-- Empty state -->
    <div
      v-if="events.length === 0"
      class="flex flex-col items-center justify-center py-16 text-center"
    >
      <div class="mb-2 text-zinc-600">
        <svg class="mx-auto h-8 w-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.5"
            d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
      </div>
      <p class="text-xs text-zinc-500">Waiting for agent activity...</p>
      <p class="mt-1 text-[10px] text-zinc-600">Events will appear here as the agent works</p>
    </div>

    <!-- Event stream -->
    <div v-else class="divide-y divide-zinc-800/50">
      <template v-for="(event, i) in events" :key="i">
        <!-- Tool use — Claude Code TUI style block -->
        <div v-if="event.kind === 'tool_use'" class="px-4 py-2.5">
          <div class="flex items-center gap-2">
            <span
              class="inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold"
              :class="getToolStyle(event.name).color"
            >
              {{ getToolStyle(event.name).label }}
            </span>
            <span class="truncate text-zinc-400">{{ formatDetail(event) }}</span>
          </div>
          <!-- Show edit preview for Edit/Write -->
          <div
            v-if="(event.name === 'Edit' || event.name === 'Write') && event.input?.old_string"
            class="mt-1.5 ml-1 border-l-2 border-zinc-700 pl-3 text-[11px]"
          >
            <div class="text-red-400/70 line-through">
              {{ String(event.input.old_string).split("\n")[0]?.slice(0, 80) }}
            </div>
            <div v-if="event.input?.new_string" class="text-emerald-400/70">
              {{ String(event.input.new_string).split("\n")[0]?.slice(0, 80) }}
            </div>
          </div>
          <!-- Show command for Bash -->
          <div
            v-if="event.name === 'Bash' && event.input?.command"
            class="mt-1.5 ml-1 rounded border border-zinc-800 bg-black px-2.5 py-1.5 text-[11px] text-emerald-300/80"
          >
            $ {{ String(event.input.command).slice(0, 120) }}
          </div>
        </div>

        <!-- Thinking — subtle italic like Claude Code -->
        <div v-else-if="event.kind === 'thinking'" class="px-4 py-2">
          <span class="text-[11px] italic text-zinc-500">{{ event.summary }}</span>
        </div>

        <!-- Text output — Claude's markdown response -->
        <div
          v-else-if="event.kind === 'text'"
          class="px-4 py-2.5 text-zinc-200 whitespace-pre-wrap leading-relaxed"
        >
          {{ event.content }}
        </div>

        <!-- Result — session complete banner -->
        <div v-else-if="event.kind === 'result'" class="px-4 py-3">
          <div
            class="flex items-center justify-between rounded-lg border px-3 py-2"
            :class="
              event.isError
                ? 'border-red-500/30 bg-red-500/5'
                : 'border-emerald-500/30 bg-emerald-500/5'
            "
          >
            <div class="flex items-center gap-2">
              <span
                class="text-xs font-semibold"
                :class="event.isError ? 'text-red-400' : 'text-emerald-400'"
              >
                {{ event.isError ? "✕ Failed" : "✓ Completed" }}
              </span>
            </div>
            <div class="flex items-center gap-3 text-[11px] text-zinc-500">
              <span>{{ event.numTurns }} turns</span>
              <span>{{ formatDuration(event.durationMs) }}</span>
              <span>${{ event.costUsd?.toFixed(4) }}</span>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
