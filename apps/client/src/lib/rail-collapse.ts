import { isSoloRepo, type RepoData } from "@/lib/agentboard";
import { folderNodeKey } from "@/lib/rail-nodes";

/** One entry of the persisted collapse map, already resolved to its new value. */
export type CollapseChange = { key: string; collapsed: boolean };

// Alt+Shift+↑/↓ act on the whole rail, where the tree cursor acts on one row.
// An empty result means the chord addressed nothing, so the handler declines
// rather than swallowing the keystroke.
export function railCollapseAll(repos: RepoData[], collapsed: Record<string, boolean>) {
  return repos.filter((r) => !collapsed[r.key]).map((r) => ({ key: r.key, collapsed: true }));
}

// Expand-all reaches both levels: a repo opened onto nothing but folded
// checkouts would read as a broken chord.
export function railExpandAll(
  repos: RepoData[],
  collapsed: Record<string, boolean>,
): CollapseChange[] {
  const out: CollapseChange[] = [];
  for (const repo of repos) {
    if (collapsed[repo.key]) out.push({ key: repo.key, collapsed: false });
    if (isSoloRepo(repo)) continue;
    for (const folder of repo.folders) {
      const key = folderNodeKey(repo.key, folder.dir);
      if (collapsed[key]) out.push({ key, collapsed: false });
    }
  }
  return out;
}
