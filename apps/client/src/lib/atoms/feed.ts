import { Effect, type Scope } from "effect";
import * as Atom from "effect/reactivity/Atom";
import { appEffect } from "@/lib/atoms/registry";
import { isTauri } from "@/lib/tauri";

/** Listen to a Tauri `event` for the life of the enclosing scope. The listener
 * is registered when this returns, so a read that follows cannot miss an event
 * (the subscribe-then-read rule). Outside Tauri it is a no-op. */
export const onEvent = (
  event: string,
  handler: (payload: unknown) => void,
): Effect.Effect<void, never, Scope.Scope> =>
  isTauri()
    ? Effect.asVoid(
        Effect.acquireRelease(
          Effect.promise(async () => {
            const { listen } = await import("@tauri-apps/api/event");
            return listen<unknown>(event, (e) => handler(e.payload));
          }),
          (unlisten) => Effect.sync(unlisten),
        ),
      )
    : Effect.void;

/** An app-lifetime feed: `body` sets up listeners and initial reads, then the
 * feed holds its scope open until the app stops. A failure is logged, never
 * thrown. Started by `startAppEffects`, so tests never open a listener. */
export function feed(
  name: string,
  body: () => Effect.Effect<unknown, unknown, Scope.Scope>,
): Atom.Atom<unknown> {
  return appEffect(
    Atom.make(
      Effect.suspend(body).pipe(
        Effect.andThen(Effect.never),
        Effect.catchCause((cause) => Effect.sync(() => console.error(`feed ${name}`, cause))),
      ),
    ).pipe(Atom.keepAlive, Atom.withLabel(name)),
  );
}
