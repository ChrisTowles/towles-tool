import { useSyncExternalStore } from "react";

/** A value outside React that readers subscribe to by slice. */
export type Store<T> = {
  get: () => T;
  /** A no-op when `next` is the held reference, so a payload that changed
   * nothing wakes no subscriber. */
  set: (next: T) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (next === value) return;
      value = next;
      for (const l of listeners) l();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Re-renders only when `selector`'s result changes by `Object.is`. It must
 * return a reference that holds while its slice is unchanged — a subtree of a
 * structurally shared value does; a freshly built array or object does not. */
export function useStoreSelector<T, S>(store: Store<T>, selector: (value: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}
