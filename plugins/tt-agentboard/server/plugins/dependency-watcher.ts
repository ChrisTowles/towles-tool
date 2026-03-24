import { eventBus } from "../utils/event-bus";
import { dependencyResolver } from "../services/dependency-resolver";
import { logger } from "../utils/logger";

export default defineNitroPlugin(() => {
  eventBus.on("workflow:completed", async (data: { cardId: number; status: string }) => {
    if (data.status !== "completed") return;

    try {
      const unblocked = await dependencyResolver.resolveAfterCompletion(data.cardId);
      for (const cardId of unblocked) {
        eventBus.emit("card:moved", {
          cardId,
          fromColumn: "backlog",
          toColumn: "ready",
        });
        eventBus.emit("card:status-changed", { cardId, status: "idle" });
      }
    } catch (error) {
      logger.error(`Dependency resolution failed after card ${data.cardId} completed:`, error);
    }
  });

  logger.info("Dependency watcher plugin loaded");
});
