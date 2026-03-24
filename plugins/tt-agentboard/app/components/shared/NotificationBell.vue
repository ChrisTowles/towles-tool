<script setup lang="ts">
import { STATUS_LABELS } from "~/utils/constants";
import type { CardStatus } from "~/utils/constants";

const {
  permission,
  unreadCount,
  notifications,
  requestPermission,
  clearUnread,
  clearAll,
  bindWebSocket,
} = useNotifications();
const { on, off } = useWebSocket();

const showDropdown = ref(false);

// Bind notifications to WebSocket
let unbind: (() => void) | null = null;
onMounted(() => {
  unbind = bindWebSocket({ on, off });
});
onUnmounted(() => {
  unbind?.();
});

function toggleDropdown() {
  showDropdown.value = !showDropdown.value;
  if (showDropdown.value) {
    clearUnread();
  }
}

function handleEnable() {
  requestPermission();
}
</script>

<template>
  <div class="relative">
    <button
      class="relative rounded-lg border border-zinc-700 bg-zinc-800 p-1.5 text-zinc-400 transition-colors hover:border-zinc-600 hover:bg-zinc-700 hover:text-zinc-200"
      title="Notifications"
      @click="toggleDropdown"
    >
      <!-- Bell SVG -->
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-4 w-4"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </svg>

      <!-- Badge -->
      <span
        v-if="unreadCount > 0"
        class="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white"
      >
        {{ unreadCount > 9 ? "9+" : unreadCount }}
      </span>
    </button>

    <!-- Dropdown -->
    <div
      v-if="showDropdown"
      class="absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl"
    >
      <div class="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <span class="text-xs font-medium text-zinc-300">Notifications</span>
        <button
          v-if="notifications.length > 0"
          class="text-[10px] text-zinc-500 hover:text-zinc-300"
          @click="clearAll"
        >
          Clear all
        </button>
      </div>

      <!-- Enable notifications prompt -->
      <div v-if="permission === 'default'" class="border-b border-zinc-800 px-3 py-2">
        <button
          class="w-full rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500"
          @click="handleEnable"
        >
          Enable browser notifications
        </button>
      </div>

      <div class="max-h-64 overflow-y-auto">
        <div
          v-for="n in notifications"
          :key="`${n.id}-${n.time.getTime()}`"
          class="cursor-pointer border-b border-zinc-800/50 px-3 py-2 transition-colors hover:bg-zinc-800/50 last:border-b-0"
          @click="
            navigateTo(`/cards/${n.id}`);
            showDropdown = false;
          "
        >
          <div class="text-xs font-medium text-zinc-200">{{ n.title }}</div>
          <div class="mt-0.5 flex items-center gap-2 text-[10px] text-zinc-500">
            <span
              :class="{
                'text-red-400': n.status === 'failed',
                'text-amber-400': n.status === 'waiting_input',
                'text-emerald-400': n.status === 'review_ready',
              }"
            >
              {{ STATUS_LABELS[n.status as CardStatus] ?? n.status }}
            </span>
          </div>
        </div>

        <div v-if="notifications.length === 0" class="px-3 py-4 text-center text-xs text-zinc-600">
          No notifications yet
        </div>
      </div>
    </div>
  </div>
</template>
