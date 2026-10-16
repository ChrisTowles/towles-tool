import { useEffect } from "react";
import { toast } from "@/lib/toast";
import { latestKeyboardScore } from "@/lib/keyboard-score";
import type { ScreenId } from "@/lib/screens";
import { loadUserSettings, onSettingsChanged } from "@/lib/settings";
import { SHORTCUTS, modifierHint, shortcutHint } from "@/lib/shortcuts";
import { uiAction } from "@/lib/ui-action";

/**
 * The pointer half of the keyboard-habit loop. Only an *exact* twin of a
 * binding may call {@link mouseAction} — a near-twin scores as a miss and lies.
 */

/** Clicks before the one tip: the third use is a habit forming, not a stray click. */
export const NUDGE_AFTER_CLICKS = 3;

export const FLUENT_USES = 10;

/** Consecutive rail steps, each within this of the last, that earn the jump tip. */
const STEP_RUN = 3;
export const STEP_GAP_MS = 1500;

/** Persisted, so each binding's tip is shown once ever — a reminder that repeats
 * is a scolding, and one that never comes is a shortcut nobody learns. */
export type CoachState = {
  clicks: Record<string, number>;
  nudged: string[];
};

export const emptyCoachState = (): CoachState => ({ clicks: {}, nudged: [] });

/** Count a click; nudge exactly once, on the {@link NUDGE_AFTER_CLICKS}th, unless
 * today's log already shows the binding driven from the keyboard. */
export function noteClick(
  state: CoachState,
  id: string,
  ctx: { enabled: boolean; keyboardUsesToday: number },
): { state: CoachState; nudge: boolean } {
  const clicks = (state.clicks[id] ?? 0) + 1;
  const counted = { ...state, clicks: { ...state.clicks, [id]: clicks } };
  const nudge =
    ctx.enabled &&
    clicks >= NUDGE_AFTER_CLICKS &&
    !state.nudged.includes(id) &&
    ctx.keyboardUsesToday < FLUENT_USES;
  return { state: nudge ? { ...counted, nudged: [...state.nudged, id] } : counted, nudge };
}

/** Rail stepping one row at a time: a run of {@link STEP_RUN} quick steps is a
 * jump the digits would make in one key. */
export function noteStep(run: { count: number; at: number }, now: number) {
  return { count: now - run.at <= STEP_GAP_MS ? run.count + 1 : 1, at: now };
}

export function keyboardUsesToday(
  score: { today: { byShortcut: { id: string; shortcut: number }[] } } | null,
  id: string,
): number {
  return score?.today.byShortcut.find((s) => s.id === id)?.shortcut ?? 0;
}

const COACH_KEY = "tt-shortcut-coach";

export function parseCoachState(raw: string | null): CoachState {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<CoachState>) : null;
    if (!v || typeof v !== "object") return emptyCoachState();
    const clicks = v.clicks && typeof v.clicks === "object" ? v.clicks : {};
    const nudged = Array.isArray(v.nudged) ? v.nudged.filter((x) => typeof x === "string") : [];
    return { clicks, nudged };
  } catch {
    return emptyCoachState();
  }
}

function load(): CoachState {
  try {
    return parseCoachState(localStorage.getItem(COACH_KEY));
  } catch {
    return emptyCoachState();
  }
}

function save(s: CoachState): void {
  try {
    localStorage.setItem(COACH_KEY, JSON.stringify(s));
  } catch {
    // A tip shown twice beats a click that throws.
  }
}

let state: CoachState | null = null;
let stepRun = { count: 0, at: 0 };
let enabled = true;

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

  const r = noteClick(state ?? load(), id, { enabled, keyboardUsesToday: uses(id) });
  state = r.state;
  save(state);
  if (!r.nudge) return;
  uiAction("coach.tip", screen, id);
  toast(`Tip: ${shortcutHint(id)}`, { description: shortcut.description, timeout: 6000 });
}

const JUMP_TIP = "ab-jump-session-1";

/** Call on every one-row rail step; a quick run of them earns the one-time
 * "hold to number the rail" tip. */
export function railStep(screen: ScreenId): void {
  stepRun = noteStep(stepRun, Date.now());
  if (!enabled || stepRun.count < STEP_RUN) return;
  const s = state ?? load();
  if (s.nudged.includes(JUMP_TIP)) return;
  state = { ...s, nudged: [...s.nudged, JUMP_TIP] };
  save(state);
  uiAction("coach.tip", screen, JUMP_TIP);
  toast(`Tip: hold ${modifierHint(JUMP_TIP)} to number the rail`, {
    description: "Then press a digit to jump straight to that row.",
    timeout: 6000,
  });
}

function uses(id: string): number {
  return keyboardUsesToday(latestKeyboardScore(), id);
}
