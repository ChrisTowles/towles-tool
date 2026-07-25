import type { TaskItem } from "@/lib/data";

/**
 * Why a Board card is sitting in `done` when nobody put it there.
 *
 * The collector rolls a linked task across the done boundary on its own once
 * every linked issue is closed and every linked PR is merged or closed
 * (`tt_collect::rollup_task_statuses`). From the Board that looks like a card
 * that finished itself, and the only evidence on screen is a row of link chips
 * the eye reads as decoration. This module reconstructs the rollup's own guard
 * from the snapshot so the card can name the refs that resolved it.
 *
 * Nothing is persisted for this: the guard is a pure function of the task's
 * links, so re-deriving it here always agrees with the backend that moved the
 * card, and there is no reason column to keep truthful across detaches,
 * reopens and manual moves.
 */

/** One resolved link that counts as evidence the task is finished. */
export type RollupEvidence = {
  kind: "issue" | "pr";
  /** `PR #496` / `#339` — matches the chip the card already renders. */
  ref: string;
  /** `owner/repo#496` — the unambiguous ref, for the tooltip. */
  qualified: string;
  /** The link's observed terminal state: `merged` or `closed`. */
  state: string;
};

/** The rollup that explains a `done` card, or `null` when nothing did. */
export type TaskRollup = {
  /** Every resolved link, in the card's chip order (issues, then PRs). */
  evidence: RollupEvidence[];
  /** One line for the card — `PR #496 merged`, or counts once it gets long. */
  summary: string;
};

/** Above this many links the summary switches from naming refs to counting
 * them; four `owner/repo#123 merged` phrases stop being readable at 11px. */
const NAME_REFS_UP_TO = 3;

/**
 * The rollup behind a `done` card, or `null` if the card got there some other
 * way.
 *
 * Mirrors `rollup_task_statuses`'s guard on purpose — a card only qualifies
 * when it is in `done`, carries no recorded `outcome` (an explicit close is
 * the user's decision, already spelled out by the card's outcome badge; a
 * rollup line there would be inventing a cause), has at least one link, and
 * every one of those links has reached a terminal state. A card whose links
 * were detached after the fact reports nothing rather than guessing.
 */
export function taskRollup(task: TaskItem): TaskRollup | null {
  if (task.status !== "done" || task.outcome !== undefined) return null;
  if (task.issues.length === 0 && task.prs.length === 0) return null;
  const resolvedIssues = task.issues.every((l) => l.state === "closed");
  const resolvedPrs = task.prs.every((l) => l.state === "merged" || l.state === "closed");
  if (!resolvedIssues || !resolvedPrs) return null;
  const evidence: RollupEvidence[] = [
    ...task.issues.map(
      (l): RollupEvidence => ({
        kind: "issue",
        ref: `#${l.number}`,
        qualified: `${l.repo}#${l.number}`,
        state: l.state,
      }),
    ),
    ...task.prs.map(
      (l): RollupEvidence => ({
        kind: "pr",
        ref: `PR #${l.number}`,
        qualified: `${l.repo}#${l.number}`,
        state: l.state,
      }),
    ),
  ];
  return { evidence, summary: summarize(evidence) };
}

/** `PR #496 merged · #339 closed` for a few refs, `2 PRs merged · 1 issue
 * closed` once naming them all would overflow the card. */
function summarize(evidence: RollupEvidence[]): string {
  if (evidence.length <= NAME_REFS_UP_TO) {
    return evidence.map((e) => `${e.ref} ${e.state}`).join(" · ");
  }
  const count = (kind: RollupEvidence["kind"], state: string) =>
    evidence.filter((e) => e.kind === kind && e.state === state).length;
  const counts = [
    countPhrase(count("pr", "merged"), "PR", "merged"),
    countPhrase(count("pr", "closed"), "PR", "closed"),
    countPhrase(count("issue", "closed"), "issue", "closed"),
  ];
  return counts.filter((phrase) => phrase !== null).join(" · ");
}

/** `1 PR merged` / `3 issues closed`; `null` for none of that kind. */
function countPhrase(n: number, noun: string, state: string): string | null {
  if (n === 0) return null;
  return `${n} ${noun}${n === 1 ? "" : "s"} ${state}`;
}
