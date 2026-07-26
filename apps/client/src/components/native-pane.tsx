import { useEffect, useRef, useState } from "react";
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

/**
 * A rectangle of the window handed over to a native GPU surface.
 *
 * Renders a placeholder div and keeps a compositor surface glued to it. Once
 * attached, the surface covers the div.
 *
 * ## Placement rules
 *
 * The surface sits *above* the webview and obeys the compositor rather than
 * CSS (see `lib/native-pane.ts`), so:
 * - Give it a slot with a **stable, non-scrolling** rect — inside a scroll
 *   container it overhangs rather than scrolling away.
 * - Pass `visible={false}` whenever something should appear over it (a modal,
 *   the command palette, a context menu) or its screen leaves the foreground.
 */
export function NativePane({
  paneId,
  className,
  visible = true,
  fallback,
}: {
  paneId: string;
  className?: string;
  visible?: boolean;
  /** Shown when the pane could not attach — an unsupported platform, say. */
  fallback?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const lastRect = useRef<CssRect | null>(null);
  const attached = useRef(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let disposed = false;
    let frame = 0;

    // Coalesce to one push per animation frame. A sidebar drag fires
    // ResizeObserver far faster than the compositor can use, and every push is
    // an IPC round trip plus a Wayland commit.
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

        if (!attached.current) {
          attached.current = true;
          void paneAttach(paneId, rect).then((r) =>
            r.match({
              ok: () => setUnavailable(null),
              err: (e) => {
                // Browser dev has no Tauri host; that is not a failure worth
                // reporting, just an absent pane.
                attached.current = false;
                if (!NotInTauri.is(e)) setUnavailable(e.message);
              },
            }),
          );
        } else {
          void paneSetRect(paneId, rect);
        }
      });
    };

    const observer = new ResizeObserver(push);
    observer.observe(el);

    // The element can move without resizing — a sibling above it growing, the
    // window moving, a scroll somewhere up the tree. ResizeObserver sees none
    // of those, so re-measure on the events that can shift it.
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
  }, [paneId]);

  // Visibility is a separate effect: it changes far more often than the pane
  // attaches, and rebuilding the observer for a toggle would drop the rect.
  useEffect(() => {
    if (!attached.current) return;
    void paneSetVisible(paneId, visible);
  }, [paneId, visible]);

  return (
    <div ref={ref} className={cn("relative overflow-hidden bg-black/40", className)}>
      {unavailable !== null && (
        <div className="flex h-full items-center justify-center p-3 text-center text-xs text-muted-foreground">
          {fallback ?? unavailable}
        </div>
      )}
    </div>
  );
}
