import { useEffect, useRef } from "react";
import { isTauri } from "@/lib/tauri";

// The dynamic `listen` import makes subscribing async, and an unmount in that
// gap has nothing to unlisten yet — hence `disposed`. The latest-callback ref
// keeps the handler fresh without re-subscribing, which would drop events.
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
