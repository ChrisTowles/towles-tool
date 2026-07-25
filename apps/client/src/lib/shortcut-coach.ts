import { useEffect } from "react";
import { toast } from "sonner";
import { latestKeyboardScore } from "@/lib/keyboard-score";
import type { ScreenId } from "@/lib/screens";
import { SETTINGS_SAVED_EVENT, loadUserSettings } from "@/lib/settings";
import { SHORTCUTS, shortcutHint } from "@/lib/shortcuts";
import { uiAction } from "@/lib/ui-action";

/**
 * The pointer half of the keyboard-habit loop.
 *
 * `useShortcuts` already records `shortcut.<id>` every time a binding fires.
 * This is its mirror: a click target that does exactly what a binding does
 * calls {@link mouseAction} instead of `uiAction` directly, which
 *
 * 1. records `mouse.<id>` — the one thing that makes the habit *measurable*,
 *    since a click with a keystroke available is the only honest denominator
 *    (`tt-telemetry`'s `keyboard.rs` scores the two against each other), and
 * 2. nudges: a one-line toast naming the keys, so the shortcut is learned at
 *    the moment it would have been used rather than in a list nobody reads.
 *
 * Only genuine twins may call it. A click that does something *similar* to a
 * binding (a per-row close ✕ against "close the selected session", a
 * safe-to-delete badge against "delete the focused worktree") is not a missed
 * keystroke and would make the score lie. Command-palette items are the other
 * deliberate abstention: running one is already keyboard work, and scoring it
 * as either a win or a miss would say more about ⌘K than about the binding.
 *
 * # The nudge is rate-limited three ways, and none of them is optional
 *
 * A coach that fires on every click is an antagonist. So it stays quiet
 * unless all of {@link NUDGE_COOLDOWN_MS} has passed for *that* binding, the
 * session is under {@link MAX_NUDGES_PER_SESSION}, and today's log doesn't
 * already show the user driving that binding from the keyboard
 * ({@link FLUENT_USES}) — clicking one you clearly know is a deliberate
 * choice (hands already on the mouse), not a lapse to correct. Tracking
 * continues regardless of whether the toast appears, and the whole nudge can
 * be switched off in Settings → Shortcuts without switching off the score.
 */

/** Per-binding quiet period. Long enough that a burst of clicks on the same
 * button produces one reminder, not five. */
export const NUDGE_COOLDOWN_MS = 30 * 60_000;

/** Ceiling for one app run, across all bindings. */
export const MAX_NUDGES_PER_SESSION = 5;

/** Keyboard uses of a binding *today* that count as "knows this one". */
export const FLUENT_USES = 3;

/** What the coach remembers within one app run. Nothing is persisted: a
 * reminder that survives restarts would be a scolding backlog, and the day's
 * real record lives in the event log either way. */
export type CoachState = {
  /** Last nudge per shortcut id, epoch ms. */
  nudgedAt: Record<string, number>;
  /** Nudges shown this session. */
  shown: number;
};

export const emptyCoachState = (): CoachState => ({ nudgedAt: {}, shown: 0 });

/** Pure eligibility check — the three rate limits in the module docs, in one
 * place so they're testable without a DOM, a clock, or a toast. */
export function shouldNudge(
  state: CoachState,
  id: string,
  now: number,
  ctx: { enabled: boolean; keyboardUsesToday: number },
): boolean {
  if (!ctx.enabled) return false;
  if (state.shown >= MAX_NUDGES_PER_SESSION) return false;
  if (ctx.keyboardUsesToday >= FLUENT_USES) return false;
  const last = state.nudgedAt[id];
  return last === undefined || now - last >= NUDGE_COOLDOWN_MS;
}

export function noteNudge(state: CoachState, id: string, now: number): CoachState {
  return { nudgedAt: { ...state.nudgedAt, [id]: now }, shown: state.shown + 1 };
}

/** Keyboard uses of `id` in the day's score, or 0 before the first fetch (so
 * an early click can still be coached rather than silently skipped). */
export function keyboardUsesToday(
  score: { today: { byShortcut: { id: string; shortcut: number }[] } } | null,
  id: string,
): number {
  return score?.today.byShortcut.find((s) => s.id === id)?.shortcut ?? 0;
}

let state = emptyCoachState();
let enabled = true;

/** Built-in default for `agentboard.shortcutCoach` — on. */
export const DEFAULT_SHORTCUT_COACH = true;

/**
 * Track the `agentboard.shortcutCoach` preference for {@link mouseAction},
 * which runs from click handlers and can't read it through a hook. Mounted
 * once in `App.tsx`; refreshes on the same two signals as
 * `useShortcutsWorkInTerminal` — a successful Settings save and window focus.
 */
export function useShortcutCoachSetting(): void {
  useEffect(() => {
    let alive = true;
    const load = () =>
      void loadUserSettings().then((s) => {
        if (alive && s) enabled = s.agentboard?.shortcutCoach ?? DEFAULT_SHORTCUT_COACH;
      });
    load();
    window.addEventListener("focus", load);
    window.addEventListener(SETTINGS_SAVED_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener("focus", load);
      window.removeEventListener(SETTINGS_SAVED_EVENT, load);
    };
  }, []);
}

/**
 * Record — and maybe coach — a pointer click that did shortcut `id`'s job.
 * Call it *alongside* the action's own handler, never instead of it; it
 * replaces the click's plain `uiAction` record rather than adding a second
 * one, so the action stays counted exactly once.
 */
export function mouseAction(id: string, screen: ScreenId): void {
  const shortcut = SHORTCUTS[id];
  if (!shortcut) throw new Error(`Unknown shortcut id "${id}"`);

  uiAction(`mouse.${id}`, screen);

  const now = Date.now();
  if (!shouldNudge(state, id, now, { enabled, keyboardUsesToday: uses(id) })) return;
  state = noteNudge(state, id, now);
  toast(`${shortcutHint(id)} does that`, {
    description: shortcut.description,
    duration: 4000,
  });
}

function uses(id: string): number {
  return keyboardUsesToday(latestKeyboardScore(), id);
}

/** Test seam: reset the session's nudge budget. */
export function resetCoachState(): void {
  state = emptyCoachState();
}
