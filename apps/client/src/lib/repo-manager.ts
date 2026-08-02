/** Pure logic behind Settings → Agentboard → Repos. Order is a list of tracked
 * repo **dirs**, never display names: names are collision-disambiguated on the
 * Rust side and shift as repos come and go. */

export type CandidateLike = { name: string; dir: string; active: boolean };

export function reorderDirs(
  dirs: readonly string[],
  dragged: string,
  beforeDir: string | "end",
): string[] {
  if (!dirs.includes(dragged) || dragged === beforeDir) return [...dirs];
  const rest = dirs.filter((d) => d !== dragged);
  if (beforeDir === "end") return [...rest, dragged];
  const at = rest.indexOf(beforeDir);
  if (at < 0) return [...rest, dragged];
  return [...rest.slice(0, at), dragged, ...rest.slice(at)];
}

/** The snapshot is authoritative about *which* repos exist; `order` only claims
 * a sequence, so a repo it doesn't mention lands at the end, never disappears. */
export function applyRepoOrder<T extends { dir: string }>(
  repos: readonly T[],
  order: readonly string[] | null,
): T[] {
  if (!order) return [...repos];
  const rank = new Map(order.map((dir, i) => [dir, i]));
  return repos.toSorted((a, b) => {
    const ra = rank.get(a.dir) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b.dir) ?? Number.MAX_SAFE_INTEGER;
    return ra - rb;
  });
}

export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((dir, i) => dir === b[i]);
}

/** Settled is the *relative* order of the repos the drag named, not an exact
 * match: a repo tracked in another window would otherwise pin the overlay
 * forever and permanently mask the backend's real order. */
export function orderSettled(
  order: readonly string[] | null,
  snapshotDirs: readonly string[],
): boolean {
  if (order === null) return false;
  const tracked = new Set(snapshotDirs);
  return sameOrder(
    snapshotDirs.filter((dir) => order.includes(dir)),
    order.filter((dir) => tracked.has(dir)),
  );
}

/** Both signals are consulted: `active` can lag a just-issued track by a poll. */
export function untrackedCandidates(
  candidates: readonly CandidateLike[],
  trackedDirs: ReadonlySet<string>,
): CandidateLike[] {
  return candidates.filter((c) => !c.active && !trackedDirs.has(c.dir));
}

export function showAddPath(
  query: string,
  candidates: readonly CandidateLike[],
  trackedDirs: ReadonlySet<string>,
): boolean {
  const path = query.trim();
  if (!path.startsWith("/")) return false;
  if (trackedDirs.has(path)) return false;
  return !candidates.some((c) => c.dir === path);
}
