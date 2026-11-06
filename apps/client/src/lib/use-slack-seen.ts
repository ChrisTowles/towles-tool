import { useEffect, useState } from "react";
import { useAtomValue } from "@/lib/atoms/react";
import { windowFocusedAtom } from "@/lib/window-focus";
import { firstUnseenIndex, getLastSeen, markSeen, newestTs } from "@/lib/slack-seen";

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

  const focused = useAtomValue(windowFocusedAtom);
  const newest = newestTs(messages);
  useEffect(() => {
    if (visible && focused) markSeen(newest);
  }, [visible, focused, newest]);

  return visible ? firstUnseenIndex(messages, opened.baseline) : null;
}
