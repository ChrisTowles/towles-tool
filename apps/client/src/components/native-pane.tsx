import { useCallback, useEffect, useRef, useState } from "react";
import { NotInTauri } from "@/lib/errors";
import {
  measure,
  paneAttach,
  paneDetach,
  paneSetRect,
  paneSetVisible,
  sameRect,
  type CssRect,
} from "@/lib/native-pane";
import { cn } from "@/lib/utils";

/** A window rect handed to a native GPU surface. It sits above the webview and
 * obeys the compositor, not CSS: the slot must be stable and non-scrolling, and
 * anything drawn over it needs `visible={false}`. Nothing here frees the pane. */
export function NativePane({
  paneId,
  className,
  visible = true,
}: {
  paneId: string;
  className?: string;
  visible?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const lastRect = useRef<CssRect | null>(null);
  const attached = useRef(false);
  // Gates the attach — screens stay mounted, so a pane can lay out while hidden,
  // and attaching there would spin up a whole Bevy app nobody is looking at.
  const wanted = useRef(visible);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  const attach = useCallback(
    (rect: CssRect) => {
      attached.current = true;
      void paneAttach(paneId, rect).then((r) =>
        r.match({
          ok: () => setUnavailable(null),
          err: (e) => {
            attached.current = false;
            if (!NotInTauri.is(e)) setUnavailable(e.message);
          },
        }),
      );
    },
    [paneId],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let disposed = false;
    let frame = 0;

    // One push per frame — a sidebar drag outruns the IPC round trip and the
    // Wayland commit each one costs.
    const push = () => {
      if (frame !== 0 || disposed) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const node = ref.current;
        if (disposed || !node) return;

        const rect = measure(node);
        if (rect.width < 1 || rect.height < 1) return; // Mid-layout; not a real move.
        if (sameRect(lastRect.current, rect)) return;
        lastRect.current = rect;

        // A hidden pane is parked off screen; the visibility effect below
        // replays `lastRect` the moment it is wanted again.
        if (!wanted.current) return;
        if (!attached.current) attach(rect);
        else void paneSetRect(paneId, rect);
      });
    };

    const observer = new ResizeObserver(push);
    observer.observe(el);

    // The element can move without resizing, which ResizeObserver never sees.
    window.addEventListener("resize", push);
    window.addEventListener("scroll", push, true);
    push();

    return () => {
      disposed = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", push);
      window.removeEventListener("scroll", push, true);
      if (attached.current) {
        attached.current = false;
        void paneDetach(paneId);
      }
    };
  }, [paneId, attach]);

  // Separate effect: rebuilding the observer for a visibility toggle would drop
  // the rect. First show is also first attach, since `wanted` skipped it.
  useEffect(() => {
    wanted.current = visible;
    if (!attached.current) {
      if (visible && lastRect.current) attach(lastRect.current);
      return;
    }
    void paneSetVisible(paneId, visible);
  }, [paneId, visible, attach]);

  return (
    <div ref={ref} className={cn("relative overflow-hidden bg-black/40", className)}>
      {unavailable !== null && (
        <div className="flex h-full items-center justify-center p-3 text-center text-xs text-muted-foreground">
          {unavailable}
        </div>
      )}
    </div>
  );
}
