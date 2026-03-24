<script setup lang="ts">
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

const props = defineProps<{
  cardId: number;
}>();

const terminalRef = ref<HTMLDivElement | null>(null);
const terminalExists = ref(false);
const terminal = shallowRef<Terminal | null>(null);
const fitAddon = shallowRef<FitAddon | null>(null);
const lastOutput = ref("");

function initTerminal() {
  if (!terminalRef.value || terminal.value) return;

  const term = new Terminal({
    theme: {
      background: "#000000",
      foreground: "#d4d4d8",
      cursor: "#d4d4d8",
      selectionBackground: "#3f3f46",
      black: "#27272a",
      red: "#ef4444",
      green: "#22c55e",
      yellow: "#eab308",
      blue: "#3b82f6",
      magenta: "#a855f7",
      cyan: "#06b6d4",
      white: "#d4d4d8",
      brightBlack: "#52525b",
      brightRed: "#f87171",
      brightGreen: "#4ade80",
      brightYellow: "#facc15",
      brightBlue: "#60a5fa",
      brightMagenta: "#c084fc",
      brightCyan: "#22d3ee",
      brightWhite: "#fafafa",
    },
    fontSize: 12,
    fontFamily: "ui-monospace, monospace",
    cursorBlink: false,
    disableStdin: true,
    scrollback: 2000,
    convertEol: true,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(terminalRef.value);
  fit.fit();

  terminal.value = term;
  fitAddon.value = fit;
}

async function fetchTerminal() {
  try {
    const data = await $fetch<{ exists: boolean; output: string }>(
      `/api/agents/${props.cardId}/terminal`,
    );
    terminalExists.value = data.exists;

    if (data.output && data.output !== lastOutput.value) {
      lastOutput.value = data.output;
      if (terminal.value) {
        terminal.value.reset();
        terminal.value.write(data.output);
      }
    }
  } catch {
    terminalExists.value = false;
  }
}

// Handle resize
const resizeObserver = ref<ResizeObserver | null>(null);

onMounted(() => {
  initTerminal();
  fetchTerminal();

  resizeObserver.value = new ResizeObserver(() => {
    fitAddon.value?.fit();
  });
  if (terminalRef.value) {
    resizeObserver.value.observe(terminalRef.value);
  }
});

// Poll for updates
const pollInterval = ref<ReturnType<typeof setInterval> | null>(null);
onMounted(() => {
  pollInterval.value = setInterval(fetchTerminal, 2000);
});

onUnmounted(() => {
  if (pollInterval.value) clearInterval(pollInterval.value);
  resizeObserver.value?.disconnect();
  terminal.value?.dispose();
});

// Re-fetch when cardId changes
watch(
  () => props.cardId,
  () => {
    lastOutput.value = "";
    terminal.value?.reset();
    fetchTerminal();
  },
);

const mode = ref<"readonly" | "interactive">("readonly");

defineExpose({ terminalExists, refresh: fetchTerminal });
</script>

<template>
  <div class="flex h-full flex-col rounded-lg border border-zinc-800 bg-black">
    <!-- Terminal header -->
    <div class="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
      <div class="flex items-center gap-2">
        <span
          class="h-2 w-2 rounded-full"
          :class="terminalExists ? 'bg-emerald-500' : 'bg-zinc-600'"
        />
        <span class="text-[10px] font-mono text-zinc-500">card-{{ cardId }}</span>
      </div>
      <div class="flex items-center gap-2">
        <button
          v-if="terminalExists"
          class="rounded px-2 py-0.5 text-[10px] font-medium transition-colors"
          :class="
            mode === 'interactive'
              ? 'bg-blue-500/10 text-blue-400'
              : 'text-zinc-500 hover:text-zinc-300'
          "
          @click="mode = mode === 'readonly' ? 'interactive' : 'readonly'"
        >
          {{ mode === "interactive" ? "⌨ Interactive" : "Attach" }}
        </button>
        <span v-if="terminalExists" class="text-[10px] font-mono text-emerald-500">
          SESSION ACTIVE
        </span>
        <span v-else class="text-[10px] font-mono text-zinc-600">NO SESSION</span>
      </div>
    </div>

    <!-- Read-only xterm view -->
    <div v-if="mode === 'readonly'" class="flex-1 overflow-hidden p-1">
      <div ref="terminalRef" class="h-full w-full" />
      <p
        v-if="!terminalExists && !lastOutput"
        class="absolute inset-0 flex items-center justify-center text-xs text-zinc-600"
      >
        No tmux session for this card.
      </p>
    </div>

    <!-- Interactive ttyd view -->
    <div v-else class="flex-1 overflow-hidden">
      <CardTtydEmbed :card-id="cardId" />
    </div>
  </div>
</template>

<style>
@import "@xterm/xterm/css/xterm.css";
</style>
