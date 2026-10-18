/** Presets beyond the rail rows: 120–220ms, ease-out, no overshoot. Spread onto
 * a `motion.*` inside `AnimatePresence` (https://motion.dev/docs/react-animate-presence). */

/** A strip growing in above content, so what is under it eases down. */
export const stripMotion = {
  initial: { opacity: 0, height: 0, overflow: "hidden" },
  animate: { opacity: 1, height: "auto", transitionEnd: { overflow: "visible" } },
  exit: { opacity: 0, height: 0, overflow: "hidden" },
  transition: { duration: 0.18, ease: "easeOut" },
} as const;

/** A kanban card; `layout="position"` glides siblings without stretching text
 * (https://motion.dev/docs/react-layout-animations). */
export const cardMotion = {
  layout: "position",
  initial: { opacity: 0, scale: 0.98 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.98 },
  transition: { duration: 0.16, ease: "easeOut" },
} as const;

/** A kept-mounted screen fades in when `hidden` lifts (CSS restarts on display). */
export const SCREEN_FADE_CLASS = "motion-safe:animate-in motion-safe:fade-in-0 duration-150";

/** Colour changes on status dots and badges crossfade instead of snapping. */
export const COLOR_FADE_CLASS = "transition-colors duration-200 ease-out";

/** Skeleton timing: nothing for a short wait, then held a minimum once shown. */
export const SKELETON_DELAY_MS = 120;
export const SKELETON_MIN_SHOW_MS = 250;

/** Milliseconds a shown skeleton must still stay up; 0 when it may go. */
export function skeletonHoldMs(shownAt: number | null, now: number): number {
  if (shownAt === null) return 0;
  return Math.max(0, SKELETON_MIN_SHOW_MS - (now - shownAt));
}
