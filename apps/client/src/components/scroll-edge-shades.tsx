import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type Edges = { above: boolean; below: boolean };

/** Whether a scroll viewport hides content above or below, kept current as it
 * scrolls and as its content grows or shrinks. Hand `ref` to the viewport. */
export function useScrollEdges(): Edges & { ref: (el: HTMLDivElement | null) => void } {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState<Edges>({ above: false, below: false });

  useEffect(() => {
    if (!el) return;
    const measure = () => {
      const above = el.scrollTop > 1;
      const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      setEdges((cur) => (cur.above === above && cur.below === below ? cur : { above, below }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    for (const child of el.children) resize.observe(child);
    // Rows mount and unmount under the viewport; each new child needs watching too.
    const mutations = new MutationObserver(() => {
      for (const child of el.children) resize.observe(child);
      measure();
    });
    mutations.observe(el, { childList: true });
    return () => {
      el.removeEventListener("scroll", measure);
      resize.disconnect();
      mutations.disconnect();
    };
  }, [el]);

  const ref = useCallback((node: HTMLDivElement | null) => setEl(node), []);
  return { ...edges, ref };
}

/** Shades over a scroller's top and bottom edges while there is more that way.
 * Place inside a `relative` box that wraps the scroller. */
export function ScrollEdgeShades({ above, below }: Edges) {
  const shade = "pointer-events-none absolute inset-x-0 z-20 h-10 transition-opacity";
  return (
    <>
      <div
        aria-hidden
        className={cn(
          shade,
          "top-0 bg-gradient-to-b from-black to-transparent",
          above ? "opacity-100" : "opacity-0",
        )}
      />
      <div
        aria-hidden
        className={cn(
          shade,
          "bottom-0 bg-gradient-to-t from-black to-transparent",
          below ? "opacity-100" : "opacity-0",
        )}
      />
    </>
  );
}
