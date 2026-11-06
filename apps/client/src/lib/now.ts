// The app's wall clocks as atoms. A clock ticks only while something reads it:
// the registry mounts it on the first reader and stops it after the last.
import { Stream } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";

const clock = (everyMs: number): Atom.Atom<number> => {
  const ticks = Atom.make(Stream.tick(everyMs).pipe(Stream.map(() => Date.now())), {
    initialValue: Date.now(),
  });
  return Atom.make((get) => AsyncResult.getOrElse(get(ticks), () => Date.now()));
};

/** Epoch ms, every 15s: countdowns and escalation timers. */
export const nowAtom = clock(15_000);

/** Epoch ms, every second: only for a value that visibly counts seconds. */
export const nowSecondsAtom = clock(1_000);
