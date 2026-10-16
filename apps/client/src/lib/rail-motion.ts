/** Enter/exit motion for rail rows. The rail renders a backend snapshot, so a
 * removed row would unmount before CSS could run. A row grows in and collapses
 * out, so its neighbours reflow with it frame by frame — no `layout`: the rail
 * re-renders every tick and nests these three deep, and layout projection on
 * top of a live reflow moves rows twice. `overflow: hidden` only mid-motion, or
 * the nested `sticky` repo headers become scroll-trapped. */
export const railRowMotion = {
  initial: { opacity: 0, height: 0, overflow: "hidden" },
  animate: { opacity: 1, height: "auto", transitionEnd: { overflow: "visible" } },
  exit: { opacity: 0, height: 0, overflow: "hidden" },
  transition: { duration: 0.15, ease: "easeOut" },
} as const;
