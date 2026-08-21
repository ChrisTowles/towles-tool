import { useMemo } from "react";
import {
  isFolderFiltered,
  partitionQuiet,
  searchRepos,
  type FolderData,
  type RepoData,
  type SessionData,
} from "@/lib/agentboard";
import type { RailFilter } from "@/lib/settings";

export type RailIndex = {
  /** Every repo minus the hand-marked quiet checkouts (`partitionQuiet`) —
   * what is on the rail before anyone types. The standby board walks this one:
   * a search is a way to find a row, not a claim about what exists. */
  railRepos: RepoData[];
  /** `railRepos` narrowed by the header's filter — the tree, the icon strip,
   * the jump digits and the cyclers, which are what you steer while typing. */
  shownRepos: RepoData[];
  /** Repos the query took out, for the field's own readout. */
  queryHidden: number;
  /** Quiet-marked dirs per repo key, hidden or not, so a shown row can badge. */
  quietDirs: Map<string, Set<string>>;
  quietCount: number;
  /** Filtered-out checkout dirs per repo key, when the rail filter is not "all". */
  idleDirs: Map<string, Set<string>>;
  /** `railRepos` minus the filtered folders — the collapsed icon strip only. */
  visibleRepos: RepoData[];
  /** Ghost checkouts (dir gone from disk) — drives the one-click cleanup. */
  missingRepoCount: number;
  folderOf: Map<string, FolderData>;
  /** Folder dir → the backend's tracker name, for `ab_mark_seen`. */
  folderNameByDir: Map<string, string>;
  sessionById: Map<string, SessionData>;
  /** Folder dir → its owning repo, so a pane header can lead with "repo / folder". */
  repoOf: Map<string, RepoData>;
  /** Folder dir → its data, for the panes whose id carries a dir. */
  folderByDir: Map<string, FolderData>;
  /** Drives the working-context band ("where am I working, and why"). */
  activeFolder: FolderData | undefined;
  activeRepo: RepoData | undefined;
};

// The lookups stay on the **full** `repos` list while only the render surfaces
// hide anything — a pane open for a checkout since filtered, or marked quiet,
// must keep working.
export function useRailIndex(args: {
  repos: RepoData[];
  filter: RailFilter;
  /** How far back `filter: "recent"` counts as worked in. */
  recentHours: number;
  /** Repo keys whose "N idle" filter stub is peeked open right now. */
  idleRevealed: Set<string>;
  /** `agentboard.showQuiet` — the rail header's toggle. */
  showQuiet: boolean;
  /** The header's free-text repo filter; empty matches everything. */
  query: string;
  activeFolderDir: string | null;
  /** Ticks every 30s — plenty for the 45-minute idle grace window. */
  now: number;
}): RailIndex {
  const { repos, filter, recentHours, idleRevealed, showQuiet, query, activeFolderDir, now } = args;

  // The mark comes off first: everything below — filter, stubs, icon strip —
  // reasons about a rail those checkouts are already gone from.
  const {
    shown: railRepos,
    quietDirs,
    quietCount,
  } = useMemo(
    () => partitionQuiet(repos, { show: showQuiet, activeFolderDir }),
    [repos, showQuiet, activeFolderDir],
  );

  const shownRepos = useMemo(() => searchRepos(railRepos, query), [railRepos, query]);
  const queryHidden = railRepos.length - shownRepos.length;

  // A quiet checkout on screen is one you asked to see — the filter doesn't get
  // to fold it into a stub on top of that.
  const idleDirs = useMemo(() => {
    const m = new Map<string, Set<string>>();
    if (filter === "all") return m;
    for (const r of shownRepos) {
      const marked = quietDirs.get(r.key);
      const q = new Set(
        r.folders
          .filter(
            (f) =>
              isFolderFiltered(f, filter, now, recentHours) &&
              f.dir !== activeFolderDir &&
              !marked?.has(f.dir),
          )
          .map((f) => f.dir),
      );
      if (q.size > 0) m.set(r.key, q);
    }
    return m;
  }, [shownRepos, quietDirs, filter, recentHours, activeFolderDir, now]);

  // The collapsed icon strip has no room for stub rows, so there the filter
  // still just drops idle (un-revealed) folders and any repo left empty.
  const visibleRepos = useMemo(() => {
    if (filter === "all") return shownRepos;
    return shownRepos
      .map((r) => {
        const q = idleDirs.get(r.key);
        if (!q || idleRevealed.has(r.key)) return r;
        return { ...r, folders: r.folders.filter((f) => !q.has(f.dir)) };
      })
      .filter((r) => r.folders.length > 0);
  }, [shownRepos, filter, idleDirs, idleRevealed]);

  const missingRepoCount = useMemo(
    () => repos.flatMap((r) => r.folders).filter((f) => f.dirMissing).length,
    [repos],
  );

  const folderOf = useMemo(() => {
    const m = new Map<string, FolderData>();
    for (const r of repos) for (const f of r.folders) for (const s of f.sessions) m.set(s.id, f);
    return m;
  }, [repos]);

  const folderNameByDir = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of repos) for (const f of r.folders) m.set(f.dir, f.name);
    return m;
  }, [repos]);

  const sessionById = useMemo(() => {
    const m = new Map<string, SessionData>();
    for (const r of repos) for (const f of r.folders) for (const s of f.sessions) m.set(s.id, s);
    return m;
  }, [repos]);

  const repoOf = useMemo(() => {
    const m = new Map<string, RepoData>();
    for (const r of repos) for (const f of r.folders) m.set(f.dir, r);
    return m;
  }, [repos]);

  const folderByDir = useMemo(() => {
    const m = new Map<string, FolderData>();
    for (const r of repos) for (const f of r.folders) m.set(f.dir, f);
    return m;
  }, [repos]);

  const activeFolder = useMemo(
    () => repos.flatMap((r) => r.folders).find((f) => f.dir === activeFolderDir),
    [repos, activeFolderDir],
  );
  const activeRepo = activeFolder ? repoOf.get(activeFolder.dir) : undefined;

  return {
    railRepos,
    shownRepos,
    queryHidden,
    quietDirs,
    quietCount,
    idleDirs,
    visibleRepos,
    missingRepoCount,
    folderOf,
    folderNameByDir,
    sessionById,
    repoOf,
    folderByDir,
    activeFolder,
    activeRepo,
  };
}
