<script setup lang="ts">
import type { VoiceContext } from "~/composables/useVoice";

defineProps<{
  isListening: boolean;
  interimTranscript: string;
  transcript: string;
  currentContext: VoiceContext;
  contextLabel: string;
}>();

const emit = defineEmits<{
  cancel: [];
  stop: [];
}>();
</script>

<template>
  <Transition name="dictation-bar">
    <div
      v-if="isListening"
      class="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-700 bg-zinc-900/95 px-4 py-3 backdrop-blur-sm"
    >
      <div class="mx-auto flex max-w-4xl items-center gap-3">
        <!-- Pulsing mic indicator -->
        <div class="relative flex-shrink-0">
          <div class="absolute inset-0 animate-ping rounded-full bg-red-500/30" />
          <div class="relative flex h-8 w-8 items-center justify-center rounded-full bg-red-500">
            <svg class="h-4 w-4 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path
                d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5z"
              />
              <path
                d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"
              />
            </svg>
          </div>
        </div>

        <!-- Transcript display -->
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span
              class="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400"
            >
              {{ contextLabel }}
            </span>
          </div>
          <p class="mt-1 truncate text-sm text-zinc-300">
            <span v-if="transcript">{{ transcript }}</span>
            <span v-if="interimTranscript" class="text-zinc-500 italic">{{
              interimTranscript
            }}</span>
            <span v-if="!transcript && !interimTranscript" class="text-zinc-600 italic"
              >Listening...</span
            >
          </p>
        </div>

        <!-- Actions -->
        <div class="flex shrink-0 items-center gap-2">
          <button
            class="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200"
            @click="emit('cancel')"
          >
            Discard
          </button>
          <button
            class="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-red-500"
            @click="emit('stop')"
          >
            Stop
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.dictation-bar-enter-active,
.dictation-bar-leave-active {
  transition: all 0.2s ease;
}
.dictation-bar-enter-from,
.dictation-bar-leave-to {
  transform: translateY(100%);
  opacity: 0;
}
</style>
