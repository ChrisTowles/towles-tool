import { useCallback, useEffect, type DependencyList } from "react";

/**
 * Fire an async loader whenever `deps` changes, returning the same stable
 * function so callers can also invoke it manually without re-subscribing.
 */
export function useAsyncRefresh(load: () => Promise<void>, deps: DependencyList): () => void {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps is caller-supplied, not statically analyzable
  const stable = useCallback(load, deps);
  useEffect(() => {
    void stable();
  }, [stable]);
  return stable;
}
