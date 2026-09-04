import { useCallback, useEffect, useRef } from "react";

/** Fractional device pixels must not read as "the user scrolled up". */
const BOTTOM_SLACK_PX = 24;

/** Keeps a chat parked at its newest message. Every re-pin trigger is a height
 * change — a message, an image loading, the composer growing — so the list and
 * composer cover all of them. `scrollTop` past the end lands on the true
 * bottom; `scrollIntoView` on a trailing marker stops a padding short. Follows
 * only while parked, so reading history isn't yanked; `repin` is for a send. */
export function usePinToBottom(active: boolean) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const pinToBottom = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, []);

  const repin = useCallback(() => {
    pinned.current = true;
  }, []);

  useEffect(() => {
    if (!active) return;
    const boxes = [listRef.current, composerRef.current].filter((el) => el !== null);
    if (boxes.length === 0) return;
    const resize = new ResizeObserver(() => {
      if (pinned.current) pinToBottom();
    });
    for (const box of boxes) resize.observe(box);
    pinToBottom();
    return () => resize.disconnect();
  }, [active, pinToBottom]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!active || !viewport) return;
    const onScroll = () => {
      const slack = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      pinned.current = slack <= BOTTOM_SLACK_PX;
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [active]);

  return { viewportRef, listRef, composerRef, repin };
}
