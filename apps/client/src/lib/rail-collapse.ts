import type { RepoData } from "@/lib/agentboard/types";

/** One entry of the persisted collapse map, already resolved to its new value. */
export type CollapseChange = { key: string; collapsed: boolean };

// Alt+Shift+↑/↓ act on the whole rail, where the tree cursor acts on one row.
// An empty result means the chord addressed nothing, so the handler declines
// rather than swallowing the keystroke.
export function railCollapseAll(repos: RepoData[], collapsed: Record<string, boolean>) {
  return repos.filter((r) => !collapsed[r.key]).map((r) => ({ key: r.key, collapsed: true }));
}

// Only repos fold: a checkout line carries its sessions inline.
export function railExpandAll(
  repos: RepoData[],
  collapsed: Record<string, boolean>,
): CollapseChange[] {
  return repos.filter((r) => collapsed[r.key]).map((r) => ({ key: r.key, collapsed: false }));
}
