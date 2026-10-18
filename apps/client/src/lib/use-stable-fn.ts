import { useRef, useState } from "react";

/** A function with fixed identity that calls the latest `fn` passed in, so a
 * memoised child handed it still skips a render the handler closure alone
 * would have caused. Call it from an event handler or effect, never during
 * render. */
export function useStableFn<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  const [stable] = useState(
    () =>
      (...args: A) =>
        ref.current(...args),
  );
  return stable;
}

/** {@link useStableFn} for each function of a fixed-shape object. */
export function useStableFns<T extends Record<string, (...args: never[]) => unknown>>(fns: T): T {
  const ref = useRef(fns);
  ref.current = fns;
  const [stable] = useState(
    () =>
      Object.fromEntries(
        Object.keys(fns).map((k) => [k, (...args: never[]) => ref.current[k]!(...args)]),
      ) as T,
  );
  return stable;
}
