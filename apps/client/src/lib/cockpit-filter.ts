/**
 * Client-side repo filter for the Cockpit. The same functions feed the PR and
 * issue panels and their note counts, so the two never drift.
 */
import type { IssueItem, PrItem } from "@/lib/data";

/** localStorage key for the remembered repo selection. Mirrors ACTIVE_TAB_KEY
 * in workspace-persistence.ts — frontend-owned UI state, not a setting. */
export const COCKPIT_REPO_FILTER_KEY = "tt-cockpit-repo-filter";

/**
 * Deliberately *not* validated against the collected repos: on a cold start
 * the snapshot hasn't arrived, so the check would discard every selection.
 */
export function loadRepoFilter(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The distinct repos present across the Cockpit's PRs and issues, sorted for a
 * stable chip order. Empty when nothing has been collected yet.
 */
export function cockpitRepos(
  prs: readonly Pick<PrItem, "repo">[],
  issues: readonly Pick<IssueItem, "repo">[],
): string[] {
  const set = new Set<string>();
  for (const p of prs) set.add(p.repo);
  for (const i of issues) set.add(i.repo);
  return [...set].toSorted();
}

/**
 * A `null` selection (the "All" chip) matches everything, so both panels and
 * the counts derived from them stay consistent with the chip state.
 */
export function filterByRepo<T extends { repo: string }>(
  items: readonly T[],
  selected: string | null,
): T[] {
  if (selected === null) return [...items];
  return items.filter((item) => item.repo === selected);
}
