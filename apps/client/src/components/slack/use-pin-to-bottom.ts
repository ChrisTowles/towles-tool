import { useCallback, useEffect, useRef } from "react";

/** Fractional device pixels must not read as "the user scrolled up". */
const BOTTOM_SLACK_PX = 24;

/** Late-loading images above the divider shift it; follow it this long. */
const ANCHOR_MS = 1500;

/** Marks the "New" divider so opening can land on it. */
export const NEW_DIVIDER_ATTR = "data-new-divider";

/** Keeps a chat parked at its newest message. Every re-pin trigger is a height
 * change — a message, an image loading, the composer growing — so the list and
 * composer cover all of them. `scrollTop` past the end lands on the true
 * bottom; `scrollIntoView` on a trailing marker stops a padding short. Follows
 * only while parked, so reading history isn't yanked; `repin` is for a send.
 * On open (`active` and `ready`) a rendered {@link NEW_DIVIDER_ATTR} wins over
 * the bottom: the list scrolls to it and stays unparked. */
export function usePinToBottom(active: boolean, ready = true) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const anchorUntil = useRef(0);

  const pinToBottom = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, []);

  const scrollToDivider = useCallback(() => {
    const viewport = viewportRef.current;
    const marker = listRef.current?.querySelector(`[${NEW_DIVIDER_ATTR}]`);
    if (!viewport || !marker) return false;
    const offset = marker.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    viewport.scrollTop += offset - 8;
    return true;
  }, []);

  const repin = useCallback(() => {
    pinned.current = true;
    anchorUntil.current = 0;
  }, []);

  useEffect(() => {
    if (!active || !ready) return;
    const boxes = [listRef.current, composerRef.current].filter((el) => el !== null);
    if (boxes.length === 0) return;
    const resize = new ResizeObserver(() => {
      if (Date.now() < anchorUntil.current) scrollToDivider();
      else if (pinned.current) pinToBottom();
    });
    for (const box of boxes) resize.observe(box);
    if (scrollToDivider()) {
      pinned.current = false;
      anchorUntil.current = Date.now() + ANCHOR_MS;
    } else {
      pinned.current = true;
      pinToBottom();
    }
    return () => resize.disconnect();
  }, [active, ready, pinToBottom, scrollToDivider]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!active || !viewport) return;
    const onScroll = () => {
      const slack = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      pinned.current = slack <= BOTTOM_SLACK_PX;
    };
    const onUserScroll = () => {
      anchorUntil.current = 0;
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    viewport.addEventListener("wheel", onUserScroll, { passive: true });
    viewport.addEventListener("touchmove", onUserScroll, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("wheel", onUserScroll);
      viewport.removeEventListener("touchmove", onUserScroll);
    };
  }, [active]);

  return { viewportRef, listRef, composerRef, repin };
}
