import { useEffect, useRef, useState } from "react";
import { SKELETON_DELAY_MS, skeletonHoldMs } from "./motion-presets";

/** `loading`, smoothed: false for a short wait, true once it drags and for a
 * minimum after, so a placeholder never blinks. Timing is the pure
 * {@link skeletonHoldMs}. */
export function useSkeleton(loading: boolean): boolean {
  const [show, setShow] = useState(false);
  const shownAt = useRef<number | null>(null);
  useEffect(() => {
    if (loading) {
      const id = window.setTimeout(() => {
        shownAt.current = Date.now();
        setShow(true);
      }, SKELETON_DELAY_MS);
      return () => window.clearTimeout(id);
    }
    const hold = skeletonHoldMs(shownAt.current, Date.now());
    const id = window.setTimeout(() => {
      shownAt.current = null;
      setShow(false);
    }, hold);
    return () => window.clearTimeout(id);
  }, [loading]);
  return show;
}
