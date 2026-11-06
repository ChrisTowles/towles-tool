// The one atom registry. React reads it through `RegistryContext` (main.tsx);
// handlers, shortcuts and IPC callbacks outside a component use it directly.
// Contract: docs/CLIENT-STATE.md.
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import type * as Atom from "effect/reactivity/Atom";
import { scheduleTask } from "@effect/atom-react";

export const appRegistry = AtomRegistry.make({ scheduleTask, defaultIdleTTL: 400 });

/** The atom's value now, without subscribing: for a handler reading at call time. */
export const read = <A>(atom: Atom.Atom<A>): A => appRegistry.get(atom);

/** Write `value` (for a model atom, a message) through the atom's own writer. */
export const write = <R, W>(atom: Atom.Writable<R, W>, value: W): void =>
  appRegistry.set(atom, value);

/** Long-lived feeds (Tauri subscriptions, pollers) start here once, at boot. */
const effects: Atom.Atom<unknown>[] = [];

/** Register an app-lifetime effect atom; {@link startAppEffects} mounts it. */
export function appEffect<A extends Atom.Atom<unknown>>(atom: A): A {
  effects.push(atom);
  return atom;
}

/** Mounts every registered feed. Called once from main.tsx, never in tests. */
export function startAppEffects(): () => void {
  const stops = effects.map((a) => appRegistry.mount(a));
  return () => {
    for (const stop of stops) stop();
  };
}
