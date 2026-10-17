import { useEffect, useState, useSyncExternalStore } from "react";
import { firstUnseenIndex, getLastSeen, markSeen, newestTs } from "@/lib/slack-seen";

function subscribeFocus(onChange: () => void): () => void {
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  return () => {
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
  };
}

function useWindowFocused(): boolean {
  return useSyncExternalStore(subscribeFocus, () => document.hasFocus());
}

/** Index of the first message that arrived since you last looked, or `null`.
 * While `visible` and the window is focused the newest message is recorded as
 * seen, but the divider is judged against what was seen when this surface
 * opened — it stays through the visit and is gone the next time you open it. */
export function useSlackSeen(
  messages: readonly { tsRaw: string; fromMe: boolean }[],
  visible: boolean,
): number | null {
  const [opened, setOpened] = useState(() => ({
    visible,
    baseline: visible ? getLastSeen() : null,
  }));
  if (opened.visible !== visible) {
    setOpened({ visible, baseline: visible ? getLastSeen() : null });
  }

  const focused = useWindowFocused();
  const newest = newestTs(messages);
  useEffect(() => {
    if (visible && focused) markSeen(newest);
  }, [visible, focused, newest]);

  return visible ? firstUnseenIndex(messages, opened.baseline) : null;
}
