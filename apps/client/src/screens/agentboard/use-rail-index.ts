import { useMemo } from "react";
import {
  isFolderFiltered,
  type FolderData,
  type RepoData,
  type SessionData,
} from "@/lib/agentboard";
import type { RailFilter } from "@/lib/settings";

export type RailIndex = {
  /** Filtered-out checkout dirs per repo key, when the rail filter is not "all". */
  quietDirs: Map<string, Set<string>>;
  /** Repos with quiet folders dropped — for the collapsed icon strip only. */
  visibleRepos: RepoData[];
  /** Ghost checkouts (dir gone from disk) — drives the one-click cleanup. */
  missingRepoCount: number;
  /** Session id → its folder. */
  folderOf: Map<string, FolderData>;
  /** Folder dir → the backend's tracker name, for `ab_mark_seen`. */
  folderNameByDir: Map<string, string>;
  /** Session id → its data. */
  sessionById: Map<string, SessionData>;
  /** Folder dir → its owning repo, so a pane header can lead with "repo / folder". */
  repoOf: Map<string, RepoData>;
  /** Folder dir → its data, for the diff/files/preview panes (their pane id
   * carries the dir). */
  folderByDir: Map<string, FolderData>;
  /** The active folder resolved to its data + repo — drives the working-context
   * band ("where am I working, and why"). */
  activeFolder: FolderData | undefined;
  activeRepo: RepoData | undefined;
};

/**
 * Every derived lookup the rail and the pane area need, in one pass over the
 * repo tree.
 *
 * The lookups (folderOf, sessionById, …) stay on the **full** `repos` list
 * while only the two render surfaces apply the rail filter — a pane already
 * open for a now-filtered folder must keep working. `isFolderFiltered` is the
 * filter's definition (nothing going on right now, or nothing worked in the
 * last `recentHours` — see `lib/agentboard.ts`); the active folder is never
 * filtered out, so switching away from what you're looking at never happens as
 * a side effect of the filter.
 */
export function useRailIndex(args: {
  repos: RepoData[];
  filter: RailFilter;
  /** How far back `filter: "recent"` counts as worked in. */
  recentHours: number;
  /** Per-repo "show me the quiet ones anyway" toggle (the stub row). */
  quietRevealed: Record<string, boolean>;
  activeFolderDir: string | null;
  /** Ticks every 30s — plenty for the 45-minute quiet grace window. */
  now: number;
}): RailIndex {
  const { repos, filter, recentHours, quietRevealed, activeFolderDir, now } = args;

  const quietDirs = useMemo(() => {
    const m = new Map<string, Set<string>>();
    if (filter === "all") return m;
    for (const r of repos) {
      const q = new Set(
        r.folders
          .filter((f) => isFolderFiltered(f, filter, now, recentHours) && f.dir !== activeFolderDir)
          .map((f) => f.dir),
      );
      if (q.size > 0) m.set(r.key, q);
    }
    return m;
  }, [repos, filter, recentHours, activeFolderDir, now]);

  // The collapsed icon strip has no room for stub rows, so there the filter
  // still just drops quiet (un-revealed) folders and any repo left empty.
  const visibleRepos = useMemo(() => {
    if (filter === "all") return repos;
    return repos
      .map((r) => {
        const q = quietDirs.get(r.key);
        if (!q || quietRevealed[r.key]) return r;
        return { ...r, folders: r.folders.filter((f) => !q.has(f.dir)) };
      })
      .filter((r) => r.folders.length > 0);
  }, [repos, filter, quietDirs, quietRevealed]);

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
    quietDirs,
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
