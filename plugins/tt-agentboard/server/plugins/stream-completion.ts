import { eventBus } from "../shared/event-bus";
import { logger } from "../utils/logger";

/**
 * Detect agent completion from stream-json result events.
 *
 * Claude Code's HTTP Stop hooks don't fire in `-p` (print) mode.
 * Instead, we watch the stream-tailer's parsed events for the `result`
 * event which means Claude finished. When detected, we POST to the
 * same complete/failure endpoint the Stop hook would have hit.
 */
export default defineNitroPlugin(() => {
  const processed = new Set<string>();

  eventBus.on("agent:activity", async (data) => {
    const { cardId, event } = data as {
      cardId: number;
      event: { kind: string; isError?: boolean };
    };

    if (event.kind !== "result") return;

    // Deduplicate — stream-tailer may re-read the same line on file change
    const key = `${cardId}`;
    if (processed.has(key)) return;
    processed.add(key);
    // Clean up after 60s to avoid unbounded growth
    setTimeout(() => processed.delete(key), 60_000);

    const endpoint = event.isError ? "failure" : "complete";
    logger.info(`Stream detected ${endpoint} for card ${cardId}, triggering callback`);

    try {
      // Small delay to let any final stream lines flush
      await new Promise((resolve) => setTimeout(resolve, 1000));

      await $fetch(`/api/agents/${cardId}/${endpoint}`, {
        method: "POST",
        body: {},
      });
    } catch (err) {
      logger.error(`Failed to trigger ${endpoint} for card ${cardId}:`, err);
    }
  });
});
