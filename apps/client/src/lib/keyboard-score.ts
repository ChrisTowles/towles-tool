import { useEffect, useState } from "react";
import { invoke, isTauri } from "@/lib/tauri";

/** The keyboard-shortcut habit: how much of the day's *bound* work used the
 * keys. Aggregated by `tt-telemetry`'s `keyboard.rs` from the `shortcut.<id>`
 * and `mouse.<id>` `ui.action` records — nothing is tracked in the frontend. */

export type ShortcutSplit = {
  id: string;
  shortcut: number;
  mouse: number;
};

export type KeyboardDay = {
  date: string;
  shortcut: number;
  mouse: number;
  /** Null on a day with no bound actions at all — not the same as 0%. */
  share: number | null;
  goalMet: boolean;
  /** Too few bound actions to judge; streaks pass straight through it. */
  idle: boolean;
  byShortcut: ShortcutSplit[];
};

export type KeyboardScore = {
  days: KeyboardDay[];
  today: KeyboardDay;
  streak: number;
  bestStreak: number;
  windowShortcut: number;
  windowMouse: number;
  windowShare: number | null;
  byShortcut: ShortcutSplit[];
  topMissed: ShortcutSplit[];
  /** Echoed from Rust so the UI states the goal without restating constants. */
  goalShare: number;
  goalMinActions: number;
};

export const keyboardScore = () => invoke<KeyboardScore>("telemetry_keyboard");

/** Deliberately slower than the resource poll beside it: today's log file is
 * re-parsed on every call. */
const POLL_MS = 60_000;

/** Read by the shortcut coach so it can stay quiet about a binding the user
 * already knows, without a second fetch or a store. */
let latest: KeyboardScore | null = null;

export function latestKeyboardScore(): KeyboardScore | null {
  return latest;
}

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

export function fmtShare(share: number | null): string {
  return share === null ? "—" : `${Math.round(share * 100)}%`;
}

/** Null when the day is already won. */
export function actionsToGoal(day: KeyboardDay, goalShare: number, goalMin: number): number | null {
  if (day.goalMet) return null;
  // `(s + n) / (t + n) >= g` solved for n, floored at the minimum-volume rule.
  const needForShare = Math.ceil(
    (goalShare * (day.shortcut + day.mouse) - day.shortcut) / (1 - goalShare),
  );
  const needForVolume = goalMin - (day.shortcut + day.mouse);
  return Math.max(1, needForShare, needForVolume);
}
