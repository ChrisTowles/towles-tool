/**
 * Client-side repo filter for the Cockpit. Narrows the PR and issue panels to a
 * single repo (the "All" chip clears it) so you can zero in on one repo when
 * zoning in. Pure and host-independent so it unit-tests without React or the
 * Tauri shell — the same functions feed the panels and their note counts, so
 * the two never drift.
 */
import type { IssueItem, PrItem } from "@/lib/data";

/** localStorage key for the remembered repo selection. Mirrors ACTIVE_TAB_KEY
 * in workspace-persistence.ts — frontend-owned UI state, not a setting. */
export const COCKPIT_REPO_FILTER_KEY = "tt-cockpit-repo-filter";

/**
 * Restore the persisted repo selection from its raw localStorage string.
 *
 * Pure and DOM-independent (the caller passes the raw string) so it unit-tests
 * without a browser. A missing or blank value means "All repos". The stored
 * name is deliberately *not* validated against the collected repos here: on a
 * cold start the snapshot hasn't arrived yet, so a repo-list check would
 * discard every selection. `activeRepo` in the screen already falls back to
 * "all" for a name that isn't in the current list, and the selection returns
 * on its own once that repo is collected again.
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
 * Narrow a list of repo-tagged items to a single selected repo. A `null`
 * selection (the "All" chip) matches everything, so both panels and the counts
 * derived from them stay consistent with the chip state.
 */
export function filterByRepo<T extends { repo: string }>(
  items: readonly T[],
  selected: string | null,
): T[] {
  if (selected === null) return [...items];
  return items.filter((item) => item.repo === selected);
}
