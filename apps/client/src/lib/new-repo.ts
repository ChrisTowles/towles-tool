/** Parents of the tracked repos, most-used first — where a new one most likely goes. */
export function repoParentDirs(dirs: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const dir of dirs) {
    const cut = dir.replace(/\/+$/, "").lastIndexOf("/");
    if (cut <= 0) continue;
    const parent = dir.slice(0, cut);
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return [...counts.entries()].toSorted((a, b) => b[1] - a[1]).map(([p]) => p);
}

/** Mirrors `tt_git::provision::parse_clone_source`'s naming, for the placeholder only. */
export function cloneDirName(source: string): string {
  const last = source.trim().replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/, "");
}
