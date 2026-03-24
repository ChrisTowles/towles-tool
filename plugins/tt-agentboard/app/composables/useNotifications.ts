import type { BoardEvent, CardStatusChangedEvent } from "~/composables/useWebSocket";

const NOTIFY_STATUSES = new Set(["review_ready", "failed", "waiting_input"]);

const STATUS_MESSAGES: Record<string, string> = {
  review_ready: "Ready for review",
  failed: "Failed",
  waiting_input: "Waiting for input",
};

export function useNotifications() {
  const permission = ref<NotificationPermission>("default");
  const unreadCount = ref(0);
  const notifications = ref<Array<{ id: number; title: string; status: string; time: Date }>>([]);

  async function requestPermission() {
    if (!("Notification" in window)) return;
    permission.value = await Notification.requestPermission();
  }

  function showNotification(cardId: number, title: string, status: string) {
    unreadCount.value++;
    notifications.value.unshift({
      id: cardId,
      title,
      status,
      time: new Date(),
    });

    // Keep last 50 notifications
    if (notifications.value.length > 50) {
      notifications.value = notifications.value.slice(0, 50);
    }

    // Browser notification
    if (permission.value === "granted") {
      const message = STATUS_MESSAGES[status] ?? status;
      const notification = new Notification(`AgentBoard: ${title}`, {
        body: message,
        tag: `card-${cardId}`,
        icon: "/favicon.ico",
      });

      notification.onclick = () => {
        window.focus();
        navigateTo(`/cards/${cardId}`);
        notification.close();
      };
    }
  }

  function clearUnread() {
    unreadCount.value = 0;
  }

  function clearAll() {
    notifications.value = [];
    unreadCount.value = 0;
  }

  /**
   * Bind to a useWebSocket instance to receive card status notifications.
   * Returns a cleanup function.
   */
  function bindWebSocket(ws: {
    on: (type: string, handler: (event: BoardEvent) => void) => void;
    off: (type: string, handler: (event: BoardEvent) => void) => void;
  }) {
    const handler = async (event: BoardEvent) => {
      const { cardId, status } = event as CardStatusChangedEvent;
      if (!NOTIFY_STATUSES.has(status)) return;

      // Fetch card title
      try {
        const card = await $fetch<{ title: string }>(`/api/cards/${cardId}`);
        showNotification(cardId, card.title, status);
      } catch {
        showNotification(cardId, `Card #${cardId}`, status);
      }
    };

    ws.on("card:status-changed", handler);
    return () => ws.off("card:status-changed", handler);
  }

  onMounted(() => {
    if ("Notification" in window) {
      permission.value = Notification.permission;
    }
  });

  return {
    permission,
    unreadCount,
    notifications,
    requestPermission,
    showNotification,
    clearUnread,
    clearAll,
    bindWebSocket,
  };
}
