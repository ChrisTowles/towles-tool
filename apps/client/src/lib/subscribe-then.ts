import { Effect } from "effect";
import { start } from "@/lib/run";
import { isTauri } from "@/lib/tauri";

const listening = (event: string, handler: (payload: unknown) => void) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const { listen } = await import("@tauri-apps/api/event");
      return listen<unknown>(event, (e) => handler(e.payload));
    }),
    (unlisten) => Effect.sync(unlisten),
  );

/** Listens to every event in `handlers`, and only once all are registered runs
 * `after` (read the current state: an event fired before listening would
 * otherwise be missed). Returns the stop; interrupting also cancels `after`. */
export function subscribeThen(
  handlers: Record<string, (payload: unknown) => void>,
  after: Effect.Effect<unknown>,
): () => void {
  if (!isTauri()) return () => {};
  return start(
    Effect.scoped(
      Effect.gen(function* () {
        for (const [event, handler] of Object.entries(handlers)) {
          yield* listening(event, handler);
        }
        yield* after;
        return yield* Effect.never;
      }),
    ),
  );
}
