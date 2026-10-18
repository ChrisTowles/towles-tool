// The React edge for long-lived effects: subscriptions and pollers start on a
// fiber and stop by interruption, so finalizers (unlisten) always run.
import { Effect, Schedule, Schema, Stream } from "effect";
import { useEffect, useRef } from "react";
import type { DependencyList } from "react";
import { tauriEvents } from "@/lib/events";

/** Starts `effect` on its own fiber and returns the stop: interrupting runs its
 * finalizers. Failures and defects are logged, never thrown into the caller. */
export function start(effect: Effect.Effect<unknown, unknown, never>): () => void {
  const fiber = Effect.runFork(
    effect.pipe(
      Effect.catchCause((cause) => Effect.sync(() => console.error("background effect", cause))),
    ),
  );
  return () => void fiber.interruptUnsafe();
}

/** What a poll task may return: an effect, a promise, or nothing. */
type PollTask = Effect.Effect<unknown, unknown> | Promise<unknown> | void;

const asEffect = (task: PollTask): Effect.Effect<unknown, unknown> =>
  Effect.isEffect(task) ? task : Effect.promise(async () => task);

/** Runs `task` now and then `everyMs` after each run settles (`Schedule.spaced`),
 * forever. A tick that lands while the document is hidden is skipped; a failing
 * run is dropped so one bad poll can't end the loop. */
export function poll(task: () => PollTask, everyMs: number): Effect.Effect<void> {
  const tick = Effect.suspend(() =>
    document.hidden ? Effect.void : Effect.ignoreCause(asEffect(task())),
  );
  return tick.pipe(Effect.repeat(Schedule.spaced(everyMs)), Effect.asVoid);
}

/** {@link poll} started on its own fiber; call the result to stop it. */
export const startPoll = (task: () => PollTask, everyMs: number): (() => void) =>
  start(poll(task, everyMs));

/** Handler per payload of `event`, until the returned stop is called. A throwing
 * handler or a payload that misses `schema` is logged and skipped; the subscription lives on. */
export function subscribe<A = unknown>(
  event: string,
  handler: (payload: A) => void,
  schema?: Schema.Decoder<A>,
): () => void {
  const decode = schema ? Schema.decodeUnknownEffect(schema) : undefined;
  return start(
    tauriEvents(event).pipe(
      Stream.runForEach((payload) =>
        (decode ? decode(payload) : Effect.succeed(payload as A)).pipe(
          Effect.flatMap((value) => Effect.sync(() => handler(value))),
          Effect.catchCause((cause) =>
            Effect.sync(() => console.error(`${event}: payload rejected`, cause)),
          ),
        ),
      ),
    ),
  );
}

/** Effect-start-on-mount: `make()` runs when `deps` change, interrupted on cleanup. */
export function useRun(make: () => Effect.Effect<unknown, unknown, never>, deps: DependencyList) {
  useEffect(() => start(make()), deps); // eslint-disable-line react-hooks/exhaustive-deps -- caller-supplied deps
}

/** Poll for as long as the component is mounted (or `everyMs` is non-null); the
 * latest `task` runs each tick, so it may close over state without re-subscribing. */
export function usePoll(task: () => PollTask, everyMs: number | null, deps: DependencyList = []) {
  const latest = useRef(task);
  latest.current = task;
  useEffect(
    () => (everyMs === null ? undefined : startPoll(() => latest.current(), everyMs)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-supplied deps
    [everyMs, ...deps],
  );
}

/** Listen to `event` for the life of the component; the latest handler runs, so
 * it never re-subscribes (which would drop events). */
export function useTauriEvent<A = unknown>(
  event: string,
  handler: (payload: A) => void,
  schema?: Schema.Decoder<A>,
) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => subscribe<A>(event, (p) => latest.current(p), schema), [event]); // eslint-disable-line react-hooks/exhaustive-deps -- schema is a module constant
}
