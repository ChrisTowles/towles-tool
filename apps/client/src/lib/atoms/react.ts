// The React edge for atoms: the only place a component touches the registry.
// Components read with `useAtomValue` and react to a change (DOM work: focus,
// scroll, flash) with `useAtomEffect`; they never mirror an atom into useState.
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type * as Atom from "effect/reactivity/Atom";
import { useContext, useEffect, useRef } from "react";

export { useAtomValue };

/** Run `f` on every change of `atom` (and once now, unless `immediate` is
 * false) for the life of the component. The latest `f` runs, so it may close
 * over props without re-subscribing — which would replay the current value. */
export function useAtomEffect<A>(
  atom: Atom.Atom<A>,
  f: (value: A) => void,
  options: { immediate?: boolean } = {},
): void {
  const registry = useContext(RegistryContext);
  const latest = useRef(f);
  latest.current = f;
  const immediate = options.immediate ?? true;
  useEffect(
    () => registry.subscribe(atom, (v) => latest.current(v), { immediate }),
    [registry, atom, immediate],
  );
}
