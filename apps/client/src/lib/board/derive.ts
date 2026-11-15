// Everything Agent Board shows, derived from the feeds and the UI record —
// never stored, never repaired by an effect. Each atom recomputes only when an
// atom it reads changes, so a value keeps its identity while its inputs do.
// Contract: docs/CLIENT-STATE.md.
import { Option } from "effect";
import * as Atom from "effect/reactivity/Atom";
import { read } from "@/lib/atoms/registry";
import { agentboardAtom, reposAtom } from "@/lib/agentboard/state";
import {
  isFolderFiltered,
  isFolderUnmanaged,
  partitionArchived,
  searchRepos,
  withoutFolded,
} from "@/lib/agentboard/folder";
import type { FolderData, RepoData, SessionData, WindowsPayload } from "@/lib/agentboard/types";
import { parkedDirs, parksByDir } from "@/lib/agentboard/park";
import { hydrateWins, pruneWins } from "@/lib/agentboard/windows";
import { nowAtom } from "@/lib/now";
import { filterQueue, onYouHead, queueAtom, railRows, taskQueueAtom } from "@/lib/queue";
import { railHotkeyTargets } from "@/lib/rail-hotkeys";
import { railNodes } from "@/lib/rail-nodes";
import { DEFAULT_RAIL_FILTER, DEFAULT_RAIL_RECENT_HOURS } from "@/lib/rail-prefs";
import { settingAtom } from "@/lib/settings";
import { boardField, foldedLanesAtom } from "./atoms";
import { ringSlot, treeSlot, type RingSlot, type TreeSlot } from "./cursor";

const keep = <A>(a: Atom.Atom<A>) => a.pipe(Atom.keepAlive);

const railFilterAtom = settingAtom((s) => s.agentboard?.railFilter, DEFAULT_RAIL_FILTER);
const recentHoursAtom = settingAtom(
  (s) => s.agentboard?.railRecentHours,
  DEFAULT_RAIL_RECENT_HOURS,
);
const activeDirAtom = boardField("activeFolderDir");

// ── Lookups: the full repo list. A pane open for a checkout since filtered or
// parked must keep working, so only the render surfaces hide anything.

export type RepoLookups = {
  folderOf: Map<string, FolderData>;
  /** Folder dir → the backend's tracker name, for `ab_mark_seen`. */
  folderNameByDir: Map<string, string>;
  sessionById: Map<string, SessionData>;
  /** Folder dir → its owning repo, so a pane header can lead with "repo / folder". */
  repoOf: Map<string, RepoData>;
  folderByDir: Map<string, FolderData>;
  /** Ghost checkouts (dir gone from disk) — drives the one-click cleanup. */
  missingRepoCount: number;
};

export const lookupsAtom = keep(
  Atom.make((get): RepoLookups => {
    const repos = get(reposAtom);
    const l: RepoLookups = {
      folderOf: new Map(),
      folderNameByDir: new Map(),
      sessionById: new Map(),
      repoOf: new Map(),
      folderByDir: new Map(),
      missingRepoCount: 0,
    };
    for (const r of repos)
      for (const f of r.folders) {
        l.folderNameByDir.set(f.dir, f.name);
        l.repoOf.set(f.dir, r);
        l.folderByDir.set(f.dir, f);
        if (f.dirMissing) l.missingRepoCount++;
        for (const s of f.sessions) {
          l.folderOf.set(s.id, f);
          l.sessionById.set(s.id, s);
        }
      }
    return l;
  }),
);

/** Drives the working-context band ("where am I working, and why"). */
export const activeFolderAtom = keep(
  Atom.make((get) => {
    const dir = get(activeDirAtom);
    return dir === null ? undefined : get(lookupsAtom).folderByDir.get(dir);
  }),
);
export const activeRepoAtom = keep(
  Atom.make((get) => {
    const f = get(activeFolderAtom);
    return f ? get(lookupsAtom).repoOf.get(f.dir) : undefined;
  }),
);

// ── The rail's repos, narrowed in order: archived, then the search.

/** Archived repos leave before anything else looks: they are not on the rail
 * at all, so no filter, stub or tally below may count them. */
export const archiveSplitAtom = keep(Atom.make((get) => partitionArchived(get(reposAtom))));

/** The rail narrowed by the header's search — the tree, the icon strip, the
 * jump digits and the cyclers. */
export const shownReposAtom = keep(
  Atom.make((get) => searchRepos(get(archiveSplitAtom).active, get(boardField("query")))),
);

/** Each parked checkout's park as the queue reports it, by dir. */
export const parksAtom = keep(Atom.make((get) => parksByDir(get(queueAtom))));

/** Held parks per repo key — the "N parked" row. A due park, or one whose
 * agent is asking, is a row again; the checkout you are in never folds. */
export const parkedDirsAtom = keep(
  Atom.make((get) => parkedDirs(get(shownReposAtom), get(parksAtom), get(activeDirAtom))),
);

/** Unclaimed checkout dirs per repo key — the "N unmanaged" stub. Agents' own
 * worktrees fold whatever the filter says; the checkout you are in stays put. */
export const unmanagedDirsAtom = keep(
  Atom.make((get) => {
    const active = get(activeDirAtom);
    const m = new Map<string, Set<string>>();
    for (const r of get(shownReposAtom)) {
      const q = new Set(
        r.folders.filter((f) => isFolderUnmanaged(f) && f.dir !== active).map((f) => f.dir),
      );
      if (q.size > 0) m.set(r.key, q);
    }
    return m;
  }),
);

/** Filtered-out checkout dirs per repo key, when the filter is not "all". A
 * parked checkout already folds under its own row, so the filter skips it. */
export const idleDirsAtom = keep(
  Atom.make((get) => {
    const m = new Map<string, Set<string>>();
    const filter = get(railFilterAtom);
    if (filter === "all") return m;
    const now = get(nowAtom);
    const hours = get(recentHoursAtom);
    const active = get(activeDirAtom);
    const parked = get(parkedDirsAtom);
    const unmanaged = get(unmanagedDirsAtom);
    for (const r of get(shownReposAtom)) {
      const q = new Set(
        r.folders
          .filter(
            (f) =>
              isFolderFiltered(f, filter, now, hours) &&
              f.dir !== active &&
              !parked.get(r.key)?.has(f.dir) &&
              !unmanaged.get(r.key)?.has(f.dir),
          )
          .map((f) => f.dir),
      );
      if (q.size > 0) m.set(r.key, q);
    }
    return m;
  }),
);

/** The collapsed icon strip: no room for stub rows, so a folded folder is
 * dropped, and with it any repo left empty. */
export const visibleReposAtom = keep(
  Atom.make((get) => {
    const idle = get(idleDirsAtom);
    const unmanaged = get(unmanagedDirsAtom);
    const parked = get(parkedDirsAtom);
    const idleRevealed = get(boardField("idleRevealed"));
    const unmanagedRevealed = get(boardField("unmanagedRevealed"));
    const parkedRevealed = get(boardField("parkedRevealed"));
    return get(shownReposAtom)
      .map((r) => ({
        ...r,
        folders: withoutFolded(
          withoutFolded(
            withoutFolded(r.folders, unmanaged.get(r.key), unmanagedRevealed.has(r.key)),
            idle.get(r.key),
            idleRevealed.has(r.key),
          ),
          parked.get(r.key),
          parkedRevealed.has(r.key),
        ),
      }))
      .filter((r) => r.folders.length > 0);
  }),
);

// ── Folds and windows: the snapshot's saved value, with edits made here on top.

export const collapsedAtom = keep(
  Atom.make((get): Record<string, boolean> => {
    const edits = get(boardField("collapsedEdits"));
    const saved = get(agentboardAtom).collapsed;
    return Object.keys(edits).length === 0 ? saved : { ...saved, ...edits };
  }),
);

/** The window layout: the edited one, else the snapshot's (hydrated), `null`
 * until the first snapshot. Panes and windows whose session or checkout is gone
 * are pruned here, at read time — a ghost tile never renders. Mounted sessions
 * and their cwds count as valid before the snapshot catches up, so a
 * just-created task's window is not pruned away. */
export const winsAtom = keep(
  Atom.make((get): WindowsPayload | null => {
    const state = get(agentboardAtom);
    const layout = get(boardField("layout"));
    const base = layout ?? (state.ts === 0 ? null : hydrateWins(state.windows));
    if (base === null) return null;
    const open = get(boardField("open"));
    const cwds = get(boardField("cwds"));
    const validSessions = new Set(open);
    const validFolders = new Set<string>();
    for (const id of open) if (cwds[id]) validFolders.add(cwds[id]);
    for (const r of state.repos)
      for (const f of r.folders) {
        validFolders.add(f.dir);
        for (const s of f.sessions) validSessions.add(s.id);
      }
    return pruneWins(base, validSessions, validFolders);
  }),
);

export const windowsForFolderAtom = keep(
  Atom.make((get) => {
    const dir = get(activeDirAtom);
    return get(winsAtom)?.windows.filter((w) => w.folderDir === dir) ?? [];
  }),
);

export const activeWinAtom = keep(
  Atom.make((get) => {
    const dir = get(activeDirAtom);
    const wins = get(winsAtom);
    const forFolder = get(windowsForFolderAtom);
    return forFolder.find((w) => w.id === (dir && wins?.activeWindows[dir])) ?? forFolder[0];
  }),
);

/** What ⌘⇧S has to choose from: sessions in no window of the checkout. */
export const splitCandidatesAtom = keep(
  Atom.make((get) => {
    const folder = get(activeFolderAtom);
    if (!folder) return [];
    const openIds = new Set(get(windowsForFolderAtom).flatMap((w) => w.panes));
    return folder.sessions.filter((s) => !openIds.has(s.id));
  }),
);

// ── The tree's one walk, and its cursor.

const railVisAtom = keep(
  Atom.make((get) => ({
    repos: get(shownReposAtom),
    idleDirs: get(idleDirsAtom),
    idleRevealed: get(boardField("idleRevealed")),
    unmanagedDirs: get(unmanagedDirsAtom),
    unmanagedRevealed: get(boardField("unmanagedRevealed")),
    parkedDirs: get(parkedDirsAtom),
    parkedRevealed: get(boardField("parkedRevealed")),
    collapsed: get(collapsedAtom),
    activeFolderDir: get(activeDirAtom),
    wins: get(winsAtom),
  })),
);

export const railTreeAtom = keep(Atom.make((get) => railNodes(get(railVisAtom))));

/** The stored cursor resolved against the rows on screen now: a cursor whose
 * row went away lands on what stands for it, with no write. */
const treeSlotAtom = keep(
  Atom.make((get) =>
    treeSlot(
      get(railTreeAtom),
      get(boardField("railCursor")),
      Option.getOrNull(get.self<TreeSlot | null>()),
    ),
  ),
);
export const cursorNodeAtom = keep(Atom.make((get) => get(treeSlotAtom)?.node ?? null));

export const hotkeyTargetsAtom = keep(Atom.make((get) => railHotkeyTargets(get(railVisAtom))));

// ── The queue: the tree's checkouts in another order.

/** What the tree leaves out — archived repos, and unmanaged worktrees nothing
 * is running in — the queue does too. Parked rows stay: the queue has its own
 * Parked lane for them. */
export const railQueueAtom = keep(
  Atom.make((get) => {
    const active = get(activeDirAtom);
    const onRail = new Set(
      get(archiveSplitAtom).active.flatMap((r) =>
        r.folders.filter((f) => !isFolderUnmanaged(f) || f.dir === active).map((f) => f.dir),
      ),
    );
    return filterQueue(
      get(queueAtom),
      (dir) => onRail.has(dir),
      new Set(),
      () => undefined,
    );
  }),
);

export const shownQueueAtom = keep(
  Atom.make((get) => {
    const repoOf = get(lookupsAtom).repoOf;
    return filterQueue(
      get(railQueueAtom),
      () => true,
      get(boardField("repoFilter")),
      (dir) => repoOf.get(dir)?.key,
    );
  }),
);

/** The queue rows top-down, folded lanes skipped — the cursor and the digits. */
export const queueRowsAtom = keep(
  Atom.make((get) => railRows(get(shownQueueAtom), get(foldedLanesAtom))),
);

/** Every row is a checkout, so the ring follows the one on screen — and when
 * that row goes, the row that took its place. */
const ringSlotAtom = keep(
  Atom.make((get) =>
    ringSlot(
      get(shownQueueAtom).items,
      get(activeDirAtom),
      Option.getOrNull(get.self<RingSlot | null>()),
    ),
  ),
);
export const ringItemAtom = keep(Atom.make((get) => get(ringSlotAtom)?.item));

// ── Live views for helpers that read at call time (mount-only subscriptions,
// async continuations). Each `current` reads the atoms now: a view, not a copy,
// so it can never be a render behind.

export type RailSnapshot = {
  repos: RepoData[];
  folderNameByDir: Map<string, string>;
  railQueue: ReturnType<typeof filterQueue>;
  shownQueue: ReturnType<typeof filterQueue>;
  railTree: ReturnType<typeof railNodes>;
};

export const railRef: { readonly current: RailSnapshot } = {
  get current() {
    return {
      repos: read(reposAtom),
      folderNameByDir: read(lookupsAtom).folderNameByDir,
      railQueue: read(railQueueAtom),
      shownQueue: read(shownQueueAtom),
      railTree: read(railTreeAtom),
    };
  },
};

/** The checkout at the head of On you, once the queue is live (`undefined`
 * before). A subscriber hears it only when the head changes — "a new head
 * arrived" is a change of this value, with no previous-value bookkeeping. */
export const onYouHeadIdAtom = keep(
  Atom.make((get) =>
    get(taskQueueAtom).live ? (onYouHead(get(railQueueAtom))?.folderDir ?? null) : undefined,
  ),
);
