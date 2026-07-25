import { useEffect, useRef } from "react";
import { isTauri } from "@/lib/tauri";

/**
 * Subscribe to a Tauri event for the lifetime of the component.
 *
 * The `listen` import is dynamic (browser dev has no Tauri host, so
 * `isTauri()` short-circuits before it), which makes subscribing async — and
 * an unmount during that gap has nothing to unlisten yet, hence the `disposed`
 * flag that tears the subscription down the moment it resolves.
 *
 * `handler` is read through a latest-callback ref, so the subscription
 * registers exactly once while the handler still sees fresh state every
 * event — re-subscribing per render would drop events in the gap.
 */
export function useTauriEvent<T>(event: string, handler: (payload: T) => void) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const sub = await listen<T>(event, (e) => latest.current(e.payload));
      if (disposed) sub();
      else unlisten = sub;
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [event]);
}
