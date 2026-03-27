import { eventBus } from "../shared/event-bus";
import { cardService } from "../domains/cards/card-service";
import { logger } from "../utils/logger";

export default defineNitroPlugin(() => {
  eventBus.on("workflow:completed", async (data: { cardId: number; status: string }) => {
    if (data.status !== "completed") return;

    try {
      const unblocked = await cardService.resolveDependencies(data.cardId);
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
