<script setup lang="ts">
const emit = defineEmits<{
  transcription: [text: string];
}>();

const { isListening, transcript, isSupported, error, toggle } = useVoice();

// Emit transcription when recording stops and there's text
watch(isListening, (listening) => {
  if (!listening && transcript.value.trim()) {
    emit("transcription", transcript.value.trim());
  }
});
</script>

<template>
  <div v-if="isSupported" class="inline-flex items-center gap-2">
    <button
      class="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all"
      :class="
        isListening
          ? 'border-red-500 bg-red-500/10 text-red-400 animate-pulse'
          : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-700'
      "
      @click="toggle"
    >
      <span class="text-sm">{{ isListening ? "●" : "🎤" }}</span>
      {{ isListening ? "Stop" : "Voice" }}
    </button>

    <!-- Live transcript preview -->
    <span v-if="isListening && transcript" class="max-w-[200px] truncate text-[10px] text-zinc-400">
      {{ transcript }}
    </span>

    <span v-if="error" class="text-[10px] text-red-400">{{ error }}</span>
  </div>
</template>
