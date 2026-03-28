import { eventBus } from "../shared/event-bus";
import type { EventMap } from "../shared/event-bus";
import { logger } from "../utils/logger";

/**
 * Detect workflow step completion from stream-json result events.
 *
 * For multi-step workflows, the step-executor pipes claude output to
 * .claude-stream.ndjson via tee. The stream-tailer watches that file
 * and emits agent:activity events. This plugin detects the final
 * "result" event and triggers the step-complete callback.
 */
export default defineNitroPlugin(() => {
  const processed = new Set<string>();

  eventBus.on("agent:activity", async (data: EventMap["agent:activity"]) => {
    const { cardId, event, timestamp } = data;

    if (event.kind !== "result") return;

    // Deduplicate with timestamp to allow reruns of the same card
    const key = `${cardId}:${timestamp}`;
    if (processed.has(key)) return;
    processed.add(key);
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
