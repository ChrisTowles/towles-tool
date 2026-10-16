import { useEffect, useRef } from "react";
import { onPromptSubmit, typedSince } from "@/lib/agentboard/prompt-submit";
import type { SessionData } from "@/lib/agentboard/types";
import { DEFAULT_ADVANCE_AFTER_SUBMIT, useLiveSettingRef } from "@/lib/settings";
import { uiAction } from "@/lib/ui-action";

/** Long enough for the prompt to land and a follow-up keystroke to cancel the move. */
const ADVANCE_DELAY_MS = 700;

/** Answering an agent that was waiting on you moves you to the next one waiting —
 * on your own Enter only, and never while you keep typing in the pane you answered. */
export function useAdvanceAfterSubmit(
  advanceFrom: (fromSessionId: string) => boolean,
  sessionById: Map<string, SessionData>,
) {
  const enabled = useLiveSettingRef(
    (s) => s.agentboard?.advanceAfterSubmit,
    DEFAULT_ADVANCE_AFTER_SUBMIT,
  );
  const latest = useRef({ advanceFrom, sessionById });
  latest.current = { advanceFrom, sessionById };

  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const off = onPromptSubmit((termId) => {
      if (!enabled.current) return;
      if (!latest.current.sessionById.get(termId)?.needsReason) return;
      const at = Date.now();
      const t = setTimeout(() => {
        timers.delete(t);
        if (typedSince(termId, at)) return;
        if (latest.current.advanceFrom(termId))
          uiAction("agentboard.advance_after_submit", "agentboard");
      }, ADVANCE_DELAY_MS);
      timers.add(t);
    });
    return () => {
      off();
      for (const t of timers) clearTimeout(t);
    };
  }, [enabled]);
}
