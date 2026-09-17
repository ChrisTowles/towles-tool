import type { KeyboardScore } from "@/lib/keyboard-score";
import { FOLDER_FOCUSED, SHORTCUTS, modifierHint, shortcutHint } from "@/lib/shortcuts";

/** The Keyboard tab's "Start doing" list: the head of `topMissed`'s ranking —
 * worst keyboard share first — with the needs-you alerts slotted in by theirs. */

export type Recommendation = {
  /** Registry id whose keys the row shows. */
  shortcut: string;
  title: string;
  why: string;
  tip: string | null;
  /** Keyboard's share of the chances — the ranking, as in `topMissed`. */
  share: number;
  /** Chances the keys didn't get — breaks ties in share. */
  missed: number;
};

/** A habit is built one binding at a time, so the list stays short. */
export const MAX_RECOMMENDATIONS = 3;

const times = (n: number) => `${n}×`;

function tipFor(id: string): string | null {
  const { tip, when } = SHORTCUTS[id];
  if (tip) return tip();
  if (when === FOLDER_FOCUSED) {
    return `Needs a folder focused — get there with ${shortcutHint("ab-focus-up")} / ${shortcutHint("ab-focus-down")}.`;
  }
  return when ? `Works when ${when}.` : null;
}

export function recommend(score: KeyboardScore): Recommendation[] {
  const days = score.days.length;
  const worthNaming = (share: number, chances: number) =>
    chances >= score.practiceMinActions && share < score.goalShare;
  const out: Recommendation[] = [];

  for (const s of score.topMissed) {
    const shortcut = SHORTCUTS[s.id];
    const total = s.shortcut + s.mouse;
    const share = s.shortcut / total;
    if (!shortcut || !worthNaming(share, total)) continue;
    out.push({
      shortcut: s.id,
      title: shortcut.description,
      why: `Clicked ${times(s.mouse)} in ${days} days, pressed ${times(s.shortcut)}.`,
      tip: tipFor(s.id),
      share,
      missed: s.mouse,
    });
  }

  const jumps = score.byShortcut
    .filter((s) => SHORTCUTS[s.id]?.answersNeedsYou)
    .reduce((n, s) => n + s.shortcut, 0);
  const alerts = score.windowNeedsYou;
  const share = alerts === 0 ? 1 : Math.min(jumps / alerts, 1);
  if (worthNaming(share, alerts)) {
    out.push({
      shortcut: "ab-jump-next",
      title: "Answer needs-you alerts from the keyboard",
      why: `${alerts} alerts fired in ${days} days; you jumped to one by key ${times(jumps)}.`,
      tip: `${shortcutHint("ab-jump-idle")} also lands on idle agents, and holding ${modifierHint("ab-jump-session-1")} numbers the rail.`,
      share,
      missed: alerts - jumps,
    });
  }

  return out
    .toSorted((a, b) => a.share - b.share || b.missed - a.missed)
    .slice(0, MAX_RECOMMENDATIONS);
}
