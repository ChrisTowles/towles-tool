import { isSoloRepo, type RepoData } from "@/lib/agentboard";

/** One entry of the persisted collapse map, already resolved to its new value. */
export type CollapseChange = { key: string; collapsed: boolean };

export type CollapseDirection = "left" | "right" | "up" | "down";

// Alt+Shift+arrows: ←/→ walk the focused row's two levels (folder, then its
// repo), ↑/↓ act on the whole rail. An empty result means the chord addressed
// nothing, so the handler declines rather than swallowing the keystroke.
export function railCollapseMove(args: {
  /** What is on the rail right now — a chord must not fold a hidden repo. */
  repos: RepoData[];
  activeFolderDir: string | null;
  collapsed: Record<string, boolean>;
  direction: CollapseDirection;
}): CollapseChange[] {
  const { repos, activeFolderDir, collapsed, direction } = args;

  if (direction === "up") {
    return repos.filter((r) => !collapsed[r.key]).map((r) => ({ key: r.key, collapsed: true }));
  }
  if (direction === "down") return expandEverything(repos, collapsed);

  if (!activeFolderDir) return [];
  const repo = repos.find((r) => r.folders.some((f) => f.dir === activeFolderDir));
  if (!repo) return [];
  // A solo repo wears one header for both levels, so it only ever has the repo key.
  const folderKey = isSoloRepo(repo) ? null : folderCollapseKey(repo, activeFolderDir);

  if (direction === "left") {
    if (folderKey && !collapsed[folderKey]) return [{ key: folderKey, collapsed: true }];
    return collapsed[repo.key] ? [] : [{ key: repo.key, collapsed: true }];
  }
  if (collapsed[repo.key]) return [{ key: repo.key, collapsed: false }];
  if (folderKey && collapsed[folderKey]) return [{ key: folderKey, collapsed: false }];
  return [];
}

export function folderCollapseKey(repo: RepoData, folderDir: string): string {
  return `${repo.key}::${folderDir}`;
}

// Expand-all reaches both levels: a repo opened onto nothing but folded folders
// would read as a broken chord.
function expandEverything(repos: RepoData[], collapsed: Record<string, boolean>): CollapseChange[] {
  const out: CollapseChange[] = [];
  for (const repo of repos) {
    if (collapsed[repo.key]) out.push({ key: repo.key, collapsed: false });
    if (isSoloRepo(repo)) continue;
    for (const folder of repo.folders) {
      const key = folderCollapseKey(repo, folder.dir);
      if (collapsed[key]) out.push({ key, collapsed: false });
    }
  }
  return out;
}
