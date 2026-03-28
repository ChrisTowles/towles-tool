<script setup lang="ts">
import { SHORTCUT_REGISTRY, SHORTCUT_CATEGORIES } from "~/composables/useKeyboardShortcuts";

const emit = defineEmits<{
  close: [];
}>();

const grouped = computed(() => {
  const groups: Record<string, typeof SHORTCUT_REGISTRY> = {};
  for (const shortcut of SHORTCUT_REGISTRY) {
    const cat = shortcut.category;
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(shortcut);
  }
  return groups;
});

const categoryOrder = ["general", "navigation", "card", "tabs"];
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        class="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
        @click.self="emit('close')"
        @keydown.escape="emit('close')"
      >
        <div
          class="relative mx-4 w-full max-w-lg rounded-xl border border-zinc-700/50 bg-zinc-900 shadow-2xl shadow-black/50"
        >
          <!-- Header -->
          <div class="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
            <div class="flex items-center gap-3">
              <div
                class="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400"
              >
                ⌨
              </div>
              <div>
                <h2 class="text-sm font-semibold text-zinc-100">Keyboard Shortcuts</h2>
                <p class="text-[11px] text-zinc-500">Navigate faster with your keyboard</p>
              </div>
            </div>
            <button
              class="rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
              @click="emit('close')"
            >
              <svg
                class="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="2"
              >
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <!-- Shortcut groups -->
          <div class="max-h-[60vh] overflow-y-auto px-6 py-4">
            <div
              v-for="cat in categoryOrder"
              :key="cat"
              class="mb-5 last:mb-0"
            >
              <h3 class="mb-2 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
                {{ SHORTCUT_CATEGORIES[cat] }}
              </h3>
              <div class="space-y-1">
                <div
                  v-for="shortcut in grouped[cat]"
                  :key="shortcut.key"
                  class="flex items-center justify-between rounded-lg px-3 py-2 transition-colors hover:bg-zinc-800/50"
                >
                  <span class="text-xs text-zinc-300">{{ shortcut.description }}</span>
                  <kbd
                    class="ml-4 inline-flex min-w-[28px] items-center justify-center rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 font-mono text-[11px] font-medium text-zinc-300 shadow-sm"
                  >
                    {{ shortcut.label }}
                  </kbd>
                </div>
              </div>
            </div>
          </div>

          <!-- Footer -->
          <div
            class="flex items-center justify-between border-t border-zinc-800 px-6 py-3 text-[11px] text-zinc-600"
          >
            <span>Press <kbd class="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-zinc-400">?</kbd> to toggle</span>
            <span>
              <kbd class="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-zinc-400">Esc</kbd> to close
            </span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
