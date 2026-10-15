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
    chip: "border-merged/50 bg-merged/10 text-merged hover:bg-merged/20",
    text: "text-merged",
    border: "border-l-merged",
    badge: "bg-merged/15 text-merged dark:bg-merged/20",
  },
  failed: {
    chip: "border-danger/50 bg-danger/10 text-danger hover:bg-danger/20",
    text: "text-danger",
    border: "border-l-danger",
    badge: "bg-danger/15 text-danger dark:bg-danger/20",
  },
  running: {
    chip: "border-busy/50 bg-busy/10 text-busy hover:bg-busy/20",
    text: "text-busy",
    border: "border-l-busy",
    badge: "bg-busy/15 text-busy-deep dark:bg-busy/20 dark:text-busy",
  },
  passing: {
    chip: "border-ok/50 bg-ok/10 text-ok hover:bg-ok/20",
    text: "text-ok",
    border: "border-l-ok",
    badge: "bg-ok/15 text-ok dark:bg-ok/20",
  },
  review: {
    chip: "border-waiting/50 bg-waiting/10 text-waiting hover:bg-waiting/20",
    text: "text-waiting",
    border: "border-l-waiting",
    badge: "bg-waiting/15 text-waiting dark:bg-waiting/20",
  },
  plain: {
    chip: "border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground",
    text: "text-muted-foreground",
    border: "border-l-border",
    badge: "bg-muted text-muted-foreground",
  },
};
