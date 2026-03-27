export default defineNuxtPlugin(() => {
  const cardStore = useCardStore();
  const ws = useWebSocket();
  cardStore.bindWebSocket(ws);
  cardStore.fetchCards();
});
