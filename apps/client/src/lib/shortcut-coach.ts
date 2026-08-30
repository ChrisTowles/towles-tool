import { useEffect } from "react";
import { toast } from "sonner";
import { latestKeyboardScore } from "@/lib/keyboard-score";
import type { ScreenId } from "@/lib/screens";
import { loadUserSettings, onSettingsChanged } from "@/lib/settings";
import { SHORTCUTS, shortcutHint } from "@/lib/shortcuts";
import { uiAction } from "@/lib/ui-action";

/**
 * The pointer half of the keyboard-habit loop. Only an *exact* twin of a
 * binding may call {@link mouseAction} — a near-twin scores as a miss and lies.
 */

/** Per-binding quiet period: long enough to collapse a burst of clicks on one
 * button into a single reminder, short enough to teach on the next lapse. */
export const NUDGE_COOLDOWN_MS = 60_000;

/** Ceiling for one app run, across all bindings — anti-runaway, not a quota. */
export const MAX_NUDGES_PER_SESSION = 100;

/** Keyboard uses of a binding *today* that count as "knows this one" — a
 * habit, not the first flicker of recognition. */
export const FLUENT_USES = 10;

/** What the coach remembers within one app run. Nothing is persisted — a
 * reminder that survives restarts would be a scolding backlog. */
export type CoachState = {
  /** Last nudge per shortcut id, epoch ms. */
  nudgedAt: Record<string, number>;
  /** Nudges shown this session. */
  shown: number;
};

export const emptyCoachState = (): CoachState => ({ nudgedAt: {}, shown: 0 });

/** Quiet unless the binding's own cooldown has passed, the session is under
 * its ceiling, and today's log doesn't already show fluency with it. */
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
 * Tracks `agentboard.shortcutCoach` for {@link mouseAction}, whose reader is a
 * plain click handler — hence a module global, not `useLiveSetting`.
 */
export function useShortcutCoachSetting(): void {
  useEffect(() => {
    let alive = true;
    const unsubscribe = onSettingsChanged(() => {
      void loadUserSettings().then((s) => {
        if (alive && s) enabled = s.agentboard?.shortcutCoach ?? DEFAULT_SHORTCUT_COACH;
      });
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
}

/**
 * Call *alongside* the action's own handler: it replaces the click's plain
 * `uiAction` record rather than adding one, so the action counts exactly once.
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
