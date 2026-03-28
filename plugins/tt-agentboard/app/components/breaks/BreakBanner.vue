<script setup lang="ts">
const store = useBreakReminderStore();
</script>

<template>
  <Transition name="banner">
    <div
      v-if="store.showBanner"
      class="fixed inset-x-0 top-0 z-50 flex items-center justify-between border-b border-amber-600/30 bg-amber-950/90 px-6 py-3 backdrop-blur"
    >
      <div class="flex items-center gap-3">
        <span class="text-lg">⚠️</span>
        <div>
          <p class="text-sm font-semibold text-amber-200">
            You've been working for over {{ store.config.escalationThresholdMinutes }} minutes
          </p>
          <p class="text-sm text-amber-300/80">{{ store.currentPrompt }}</p>
        </div>
      </div>
      <div class="flex gap-2">
        <button
          class="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-500"
          @click="store.completeBreak()"
        >
          Take a break
        </button>
        <button
          class="rounded-lg border border-amber-700 px-4 py-1.5 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-900"
          @click="store.skipBreak()"
        >
          Skip
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.banner-enter-active,
.banner-leave-active {
  transition: all 0.3s ease;
}
.banner-enter-from,
.banner-leave-to {
  transform: translateY(-100%);
  opacity: 0;
}
</style>
