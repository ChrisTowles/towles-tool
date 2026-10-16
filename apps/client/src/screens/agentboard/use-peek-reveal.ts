import { useState, type Dispatch, type SetStateAction } from "react";
import type { ScreenId } from "@/lib/screens";
import { uiAction } from "@/lib/ui-action";
import { toggled } from "./helpers";

/** A stub row's peek, toggled per repo. The event is emitted outside the
 * updater: a state updater must stay pure, or StrictMode double-counts it. */
export function togglePeek(
  revealed: Set<string>,
  set: Dispatch<SetStateAction<Set<string>>>,
  event: "agentboard.idle_peek" | "agentboard.unmanaged_peek",
  screen: ScreenId,
) {
  return (repoKey: string) => {
    uiAction(event, screen, revealed.has(repoKey) ? "hide" : "show");
    set((keys) => toggled(keys, repoKey));
  };
}

/** The idle and unmanaged stubs' peeks — view state, since each belongs to one
 * glance at one repo. */
export function usePeekReveal() {
  const [idleRevealed, setIdleRevealed] = useState<Set<string>>(new Set());
  const [unmanagedRevealed, setUnmanagedRevealed] = useState<Set<string>>(new Set());
  return {
    idleRevealed,
    unmanagedRevealed,
    toggleIdleRevealed: togglePeek(
      idleRevealed,
      setIdleRevealed,
      "agentboard.idle_peek",
      "agentboard",
    ),
    toggleUnmanagedRevealed: togglePeek(
      unmanagedRevealed,
      setUnmanagedRevealed,
      "agentboard.unmanaged_peek",
      "agentboard",
    ),
  };
}
