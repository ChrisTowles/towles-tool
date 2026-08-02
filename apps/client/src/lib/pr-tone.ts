import type { PrItem } from "./data";

/** Hues follow the rail's status palette. `running` is cyan, never red/amber:
 * CI in flight is progress, not "act now". `review` is an axis about *you*, so
 * callers pick it explicitly and `prTone` never returns it. */
export type PrTone = "merged" | "failed" | "running" | "passing" | "review" | "plain";

/** **The** definition of "this PR wants you", shared by every needs-you
 * surface; three inline copies had drifted. `=== "open"` is deliberate — you
 * closed it, so its red checks are history, not a task. */
export function prNeedsYou(pr: Pick<PrItem, "state" | "checks" | "reviewState">): boolean {
  return prChecksFailing(pr) || (pr.state === "open" && pr.reviewState === "review_requested");
}

export function prChecksFailing(pr: Pick<PrItem, "state" | "checks">): boolean {
  return pr.state === "open" && pr.checks === "failing";
}

export function prRank(pr: Pick<PrItem, "state" | "checks" | "reviewState">): number {
  if (prChecksFailing(pr)) return 2;
  if (pr.reviewState === "review_requested") return 1;
  return 0;
}

export type ChecksTone = Extract<PrTone, "failed" | "passing" | "plain" | "running">;

export function checksTone(checks: string): ChecksTone {
  if (checks === "failing") return "failed";
  if (checks === "passing") return "passing";
  if (checks === "none") return "plain";
  // "pending" — and any collector value this map doesn't know yet, so a new
  // state degrades visibly (as in-flight) instead of vanishing into neutral.
  return "running";
}

export function prTone(pr: Pick<PrItem, "state" | "checks">): PrTone {
  if (pr.state === "merged") return "merged";
  if (pr.state === "closed") return "failed";
  return checksTone(pr.checks);
}

export const PR_TONE: Record<
  PrTone,
  { chip: string; text: string; border: string; badge: string }
> = {
  merged: {
    chip: "border-purple-500/50 bg-purple-500/10 text-purple-600 hover:bg-purple-500/20 dark:text-purple-400",
    text: "text-purple-600 dark:text-purple-400",
    border: "border-l-purple-500",
    badge: "bg-purple-500/15 text-purple-700 dark:bg-purple-500/20 dark:text-purple-400",
  },
  failed: {
    chip: "border-red-500/50 bg-red-500/10 text-red-600 hover:bg-red-500/20 dark:text-red-400",
    text: "text-red-500 dark:text-red-400",
    border: "border-l-red-500",
    badge: "bg-red-500/15 text-red-700 dark:bg-red-500/20 dark:text-red-400",
  },
  running: {
    chip: "border-cyan-500/50 bg-cyan-500/10 text-cyan-600 hover:bg-cyan-500/20 dark:text-cyan-400",
    text: "text-cyan-600 dark:text-cyan-400",
    border: "border-l-cyan-500",
    badge: "bg-cyan-500/15 text-cyan-700 dark:bg-cyan-500/20 dark:text-cyan-400",
  },
  passing: {
    chip: "border-green-500/50 bg-green-500/10 text-green-600 hover:bg-green-500/20 dark:text-green-400",
    text: "text-green-600 dark:text-green-400",
    border: "border-l-green-500",
    badge: "bg-green-500/15 text-green-700 dark:bg-green-500/20 dark:text-green-400",
  },
  review: {
    chip: "border-blue-500/50 bg-blue-500/10 text-blue-600 hover:bg-blue-500/20 dark:text-blue-400",
    text: "text-blue-500 dark:text-blue-400",
    border: "border-l-blue-500",
    badge: "bg-blue-500/15 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400",
  },
  plain: {
    chip: "border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground",
    text: "text-muted-foreground",
    border: "border-l-border",
    badge: "bg-muted text-muted-foreground",
  },
};
