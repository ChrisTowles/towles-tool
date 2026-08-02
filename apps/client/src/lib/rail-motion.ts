/** Enter/exit motion for rail rows. The rail renders a backend snapshot, so a
 * removed row would unmount before CSS could run. `layout="position"`, not
 * `true`: the plain form scaleY-squashes text mid-resize. `overflow: hidden` is
 * exit-only, or the nested `sticky` repo headers become scroll-trapped. */
export const railRowMotion = {
  layout: "position",
  initial: { opacity: 0, x: -8 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -8, height: 0, overflow: "hidden" },
  transition: { duration: 0.15 },
} as const;
