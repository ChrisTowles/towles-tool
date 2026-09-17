import type { KeyboardScore } from "@/lib/keyboard-score";
import { IS_MAC, SHORTCUTS, shortcutHint } from "@/lib/shortcuts";

/** The Keyboard tab's "Start doing" list: the score's counts turned into what
 * to practice next, ranked by how many times the keys were passed up. */

export type Recommendation = {
  /** Registry id whose keys the row shows. */
  shortcut: string;
  title: string;
  why: string;
  tip: string | null;
  /** Chances the keys had and didn't get — the ranking. */
  missed: number;
};

/** A habit is built one binding at a time, so the list stays short. */
export const MAX_RECOMMENDATIONS = 3;

/** Below this a gap is a stray click, not a habit worth naming. */
export const MIN_MISSED = 3;

const JUMP_IDS = ["ab-jump-next", "ab-jump-prev", "ab-jump-idle"];

const times = (n: number) => `${n}×`;

function tipFor(id: string): string | null {
  switch (id) {
    case "ab-new-task":
      return `${IS_MAC ? "⌘Enter" : "Ctrl+Enter"} then starts it, so a task never leaves the keyboard.`;
    case "ab-remove-task":
      return `Keep the modifiers held: Delete, then ${shortcutHint("ab-confirm-close-worktree")} confirms.`;
    case "ab-close-pane":
      return "Works from inside a terminal too — no need to click out first.";
  }
  const when = SHORTCUTS[id]?.when;
  if (when === "a folder is focused") {
    return `Needs a folder focused — get there with ${shortcutHint("ab-focus-up")} / ${shortcutHint("ab-focus-down")}.`;
  }
  return when ? `Works when ${when}.` : null;
}

export function recommend(score: KeyboardScore): Recommendation[] {
  const out: Recommendation[] = [];

  for (const s of score.byShortcut) {
    const shortcut = SHORTCUTS[s.id];
    const total = s.shortcut + s.mouse;
    if (!shortcut || s.mouse < MIN_MISSED || s.shortcut / total >= score.goalShare) continue;
    out.push({
      shortcut: s.id,
      title: shortcut.description,
      why: `Clicked ${times(s.mouse)} in 14 days, pressed ${times(s.shortcut)}.`,
      tip: tipFor(s.id),
      missed: s.mouse,
    });
  }

  const jumps = score.byShortcut
    .filter((s) => JUMP_IDS.includes(s.id) || s.id.startsWith("ab-jump-session-"))
    .reduce((n, s) => n + s.shortcut, 0);
  const alerts = score.windowNeedsYou;
  if (alerts - jumps >= MIN_MISSED && jumps < alerts * score.goalShare) {
    out.push({
      shortcut: "ab-jump-next",
      title: "Answer needs-you alerts from the keyboard",
      why: `${alerts} alerts fired in 14 days; you jumped to one by key ${times(jumps)}.`,
      tip: `${shortcutHint("ab-jump-idle")} also lands on idle agents, and holding ${shortcutHint("ab-jump-session-1").replace(/\+?1$/, "")} numbers the rail.`,
      missed: alerts - jumps,
    });
  }

  return out.toSorted((a, b) => b.missed - a.missed).slice(0, MAX_RECOMMENDATIONS);
}
