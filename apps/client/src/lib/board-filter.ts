/** Client-side quick filter for the Board. Pure and host-independent, so it
 * unit-tests without React or the Tauri shell. */
import type { TaskItem } from "@/lib/data";

/**
 * The worktree repo is often a card's *only* repo identity — bound at submit,
 * before any issue or PR exists — and the swimlane lanes match on it.
 */
export function matchesTaskFilter(
  task: Pick<TaskItem, "text" | "notes" | "issues" | "prs" | "worktree">,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const haystack = [
    task.text,
    task.notes ?? "",
    ...task.issues.flatMap((l) => [l.repo, `#${l.number}`]),
    ...task.prs.flatMap((l) => [l.repo, `#${l.number}`]),
    task.worktree?.repo ?? "",
    task.worktree?.branch ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}
