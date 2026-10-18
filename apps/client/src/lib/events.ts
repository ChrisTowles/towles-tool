// Tauri events as Effect streams: the unlisten lives in a scope finalizer, so a
// subscriber that stops (unmount, interrupt) can never leak a listener, and no
// call site hand-rolls a `disposed` flag around the async `listen`.
import { Effect, Queue, Stream } from "effect";
import { IpcFailed } from "@/lib/errors";
import type { IpcError } from "@/lib/errors";
import { isTauri } from "@/lib/tauri";

/** Payloads of `event` as they arrive. Outside Tauri it emits nothing and never ends. */
export function tauriEvents(event: string): Stream.Stream<unknown, IpcError> {
  if (!isTauri()) return Stream.never;
  return Stream.callback<unknown, IpcError>((queue) =>
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const { listen } = await import("@tauri-apps/api/event");
          return listen<unknown>(event, (e) => void Queue.offerUnsafe(queue, e.payload));
        },
        catch: (cause): IpcError => new IpcFailed({ command: `listen ${event}`, cause }),
      }),
      (unlisten) => Effect.sync(unlisten),
    ),
  );
}
