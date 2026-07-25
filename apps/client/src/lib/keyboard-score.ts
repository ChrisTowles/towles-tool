import { useEffect, useState } from "react";
import { invoke, isTauri } from "@/lib/tauri";

/**
 * The keyboard-shortcut habit: how much of the day's *bound* work was done
 * with the keys rather than the pointer, and how many days in a row that
 * cleared the goal.
 *
 * The numbers come from the event log, aggregated by `tt-telemetry`'s
 * `keyboard.rs` (read that module for what counts as a duel and why an idle
 * day doesn't break a streak) — nothing is tracked in the frontend beyond the
 * two `ui.action` records that feed it:
 *
 * - `shortcut.<id>`, emitted by `useShortcuts` when a binding fires.
 * - `mouse.<id>`, emitted by {@link mouseAction} in `shortcut-coach.ts` when a
 *   click does a binding's job instead.
 *
 * So the score survives restarts, needs no extra storage, and can be audited
 * line by line in the Telemetry screen's Log tab — the same completeness
 * property the rest of the event log is built on.
 */

export type ShortcutSplit = {
  /** Registry shortcut id, e.g. `"sidebar"`. */
  id: string;
  shortcut: number;
  mouse: number;
};

export type KeyboardDay = {
  /** UTC date, matching the log file's own name. */
  date: string;
  shortcut: number;
  mouse: number;
  /** `shortcut / (shortcut + mouse)`, `0..1`. Null on a day with no bound
   * actions at all — which is not the same as 0%. */
  share: number | null;
  goalMet: boolean;
  /** Too few bound actions to judge: neither a win nor a loss, and streaks
   * pass straight through it. */
  idle: boolean;
  byShortcut: ShortcutSplit[];
};

export type KeyboardScore = {
  /** The scored window, oldest first, one entry per day whether or not it had
   * a log file. */
  days: KeyboardDay[];
  today: KeyboardDay;
  /** Consecutive won days ending now. Today counts once won and is forgiven
   * until then. */
  streak: number;
  bestStreak: number;
  windowShortcut: number;
  windowMouse: number;
  windowShare: number | null;
  /** Every binding the window saw — what the `?` overlay annotates its rows
   * with. Bounded by the shortcut registry, so it isn't truncated. */
  byShortcut: ShortcutSplit[];
  /** The head of that list, ranked by pointer wins — what to practice next. */
  topMissed: ShortcutSplit[];
  /** The goal being scored against, echoed from Rust so the UI states it
   * without restating the constants. */
  goalShare: number;
  goalMinActions: number;
};

export const keyboardScore = () => invoke<KeyboardScore>("telemetry_keyboard");

/** How often the status bar re-reads the score. Today's log file is re-parsed
 * on every call (past days are cached in Rust), so this is deliberately slower
 * than the resource poll next to it — a habit metric moving once a minute is
 * as live as it needs to be. */
const POLL_MS = 60_000;

/**
 * The most recently fetched score, or null before the first fetch. Read by
 * {@link shouldNudge}'s caller so the coach can stay quiet about a shortcut
 * the user demonstrably already knows, without a second fetch or a store.
 * Written only by {@link useKeyboardScore}.
 */
let latest: KeyboardScore | null = null;

export function latestKeyboardScore(): KeyboardScore | null {
  return latest;
}

/** Poll the habit score. Returns null in browser dev and until the first
 * sample lands, matching the status bar's other readouts. */
export function useKeyboardScore(): KeyboardScore | null {
  const [score, setScore] = useState<KeyboardScore | null>(latest);
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const tick = async () => {
      const r = await keyboardScore();
      if (cancelled || r.isErr()) return;
      latest = r.value;
      setScore(r.value);
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);
  return score;
}

/** Named rungs for a day's share — the ladder the streak climbs. `null` share
 * (nothing bound happened yet) has no rung rather than the bottom one. */
export type KeyboardTier = "mouse-first" | "mixed" | "keyboard-first" | "keyboard-native";

export const TIER_LABELS: Record<KeyboardTier, string> = {
  "mouse-first": "Mouse-first",
  mixed: "Mixed",
  "keyboard-first": "Keyboard-first",
  "keyboard-native": "Keyboard-native",
};

export function tierFor(share: number | null): KeyboardTier | null {
  if (share === null) return null;
  if (share >= 0.9) return "keyboard-native";
  if (share >= 0.75) return "keyboard-first";
  if (share >= 0.5) return "mixed";
  return "mouse-first";
}

/** `0.82` → `"82%"`; a day with nothing bound yet reads as an em dash, never
 * as `0%` — the difference between "didn't use shortcuts" and "didn't do
 * anything a shortcut covers" is the whole point of the null. */
export function fmtShare(share: number | null): string {
  return share === null ? "—" : `${Math.round(share * 100)}%`;
}

/** How many more keyboard actions today needs to clear the goal, given what's
 * already recorded — the one number that turns a percentage into something
 * actionable before the day is over. Null when the day is already won. */
export function actionsToGoal(day: KeyboardDay, goalShare: number, goalMin: number): number | null {
  if (day.goalMet) return null;
  // `(s + n) / (t + n) >= g` solved for n, floored at what the minimum-volume
  // rule needs on its own.
  const needForShare = Math.ceil(
    (goalShare * (day.shortcut + day.mouse) - day.shortcut) / (1 - goalShare),
  );
  const needForVolume = goalMin - (day.shortcut + day.mouse);
  return Math.max(1, needForShare, needForVolume);
}
