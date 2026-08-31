import {
  isSoloRepo,
  withoutFolded,
  type FolderData,
  type RepoData,
  type SessionData,
  type WindowsPayload,
} from "@/lib/agentboard";

/** One row of the rail, in render order. `key` is the cursor's identity and,
 * for a row that folds, the collapse-map key it already answers to. */
export type RailNode = {
  key: string;
  kind: "repo" | "folder" | "session";
  repoKey: string;
  /** The checkout this row speaks for — null on a multi-checkout repo header. */
  dir: string | null;
  sessionId: string | null;
  /** Null on a session: a leaf has nothing to fold. */
  collapseKey: string | null;
  /** Repo 0, checkout 1, session 2 — a solo repo's sessions sit at 1. */
  depth: number;
};

export type RailVisibility = {
  repos: RepoData[];
  /** Repo key → checkout dirs the rail filter is hiding. */
  idleDirs: Map<string, Set<string>>;
  /** Repo keys whose idle rows are peeked open. */
  idleRevealed: Set<string>;
  /** Repo key → the unclaimed checkout dirs folded into the "N unmanaged" stub. */
  unmanagedDirs: Map<string, Set<string>>;
  /** Repo keys whose unmanaged rows are peeked open. */
  unmanagedRevealed: Set<string>;
  collapsed: Record<string, boolean>;
  wins: WindowsPayload | null;
};

// The one walk of the rail: the cursor, the jump digits and the collapse chords
// all read this, so "what is next" has a single answer. It mirrors what
// `RepoGroup` renders — a folded row keeps its own line but contributes no
// children, and a repo the filter emptied shrinks to a stub with no header,
// so it is no row at all.
export function railNodes(v: RailVisibility): RailNode[] {
  const { repos, idleDirs, idleRevealed, unmanagedDirs, unmanagedRevealed, collapsed, wins } = v;
  const out: RailNode[] = [];
  for (const repo of repos) {
    const shown = withoutFolded(
      withoutFolded(repo.folders, unmanagedDirs.get(repo.key), unmanagedRevealed.has(repo.key)),
      idleDirs.get(repo.key),
      idleRevealed.has(repo.key),
    );
    if (shown.length === 0) continue;

    // A solo repo wears one header for both levels, so its sessions hang
    // straight off the repo row and the repo key is the only collapse key.
    if (isSoloRepo(repo)) {
      const folder = shown[0];
      out.push({
        key: repo.key,
        kind: "repo",
        repoKey: repo.key,
        dir: folder.dir,
        sessionId: null,
        collapseKey: repo.key,
        depth: 0,
      });
      if (!collapsed[repo.key]) pushSessions(out, repo, folder, wins, 1);
      continue;
    }

    out.push({
      key: repo.key,
      kind: "repo",
      repoKey: repo.key,
      dir: null,
      sessionId: null,
      collapseKey: repo.key,
      depth: 0,
    });
    if (collapsed[repo.key]) continue;
    for (const folder of shown) {
      const key = folderNodeKey(repo.key, folder.dir);
      out.push({
        key,
        kind: "folder",
        repoKey: repo.key,
        dir: folder.dir,
        sessionId: null,
        collapseKey: key,
        depth: 1,
      });
      if (!collapsed[key]) pushSessions(out, repo, folder, wins, 2);
    }
  }
  return out;
}

export function folderNodeKey(repoKey: string, dir: string): string {
  return `${repoKey}::${dir}`;
}

export function sessionNodeKey(sessionId: string): string {
  return `session:${sessionId}`;
}

// A row can leave under the cursor — its repo folds, the filter takes it, the
// worktree is deleted. The cursor then stands on whatever now represents it,
// so the ring never simply blinks out.
export function resolveCursor(nodes: RailNode[], cursor: RailNode | null): RailNode | null {
  if (!cursor) return null;
  const exact = nodes.find((n) => n.key === cursor.key);
  if (exact) return exact;
  if (cursor.kind === "session" && cursor.dir !== null) {
    return (
      nodes.find((n) => n.kind !== "session" && n.dir === cursor.dir) ?? repoRow(nodes, cursor)
    );
  }
  if (cursor.kind === "folder") return repoRow(nodes, cursor);
  return null;
}

function repoRow(nodes: RailNode[], cursor: RailNode): RailNode | null {
  return nodes.find((n) => n.kind === "repo" && n.repoKey === cursor.repoKey) ?? null;
}

/** What a keystroke asks of the rail. `exit` is the cursor walking off a leaf's
 * right edge, which belongs to the pane grid rather than the tree. */
export type RailMove =
  | { kind: "cursor"; key: string }
  | { kind: "collapse"; key: string; collapsed: boolean }
  | { kind: "exit" };

// Tree-walk semantics: ↑/↓ step one visible row and stop at the ends, ← folds
// the row or climbs to its parent, → unfolds it or descends. Null declines, so
// the chord keeps whatever the platform does with it.
export function railMove(args: {
  nodes: RailNode[];
  cursor: string | null;
  direction: "up" | "down" | "left" | "right";
  collapsed: Record<string, boolean>;
}): RailMove | null {
  const { nodes, cursor, direction, collapsed } = args;
  if (nodes.length === 0) return null;
  const i = cursor ? nodes.findIndex((n) => n.key === cursor) : -1;

  if (direction === "up") {
    if (i === -1) return { kind: "cursor", key: nodes[nodes.length - 1].key };
    return i > 0 ? { kind: "cursor", key: nodes[i - 1].key } : null;
  }
  if (direction === "down") {
    if (i === -1) return { kind: "cursor", key: nodes[0].key };
    return i < nodes.length - 1 ? { kind: "cursor", key: nodes[i + 1].key } : null;
  }

  // Left and right need a row to act on; without one there is nothing to fold.
  if (i === -1) return null;
  const node = nodes[i];
  const folded = node.collapseKey !== null && collapsed[node.collapseKey];

  if (direction === "left") {
    if (node.collapseKey !== null && !folded) {
      return { kind: "collapse", key: node.collapseKey, collapsed: true };
    }
    const parent = parentOf(nodes, i);
    return parent ? { kind: "cursor", key: parent.key } : null;
  }

  if (node.collapseKey !== null && folded) {
    return { kind: "collapse", key: node.collapseKey, collapsed: false };
  }
  const child = nodes[i + 1];
  if (child && child.depth > node.depth) return { kind: "cursor", key: child.key };
  return { kind: "exit" };
}

function parentOf(nodes: RailNode[], i: number): RailNode | null {
  for (let j = i - 1; j >= 0; j--) {
    if (nodes[j].depth < nodes[i].depth) return nodes[j];
  }
  return null;
}

// Window-grouped first, then loose, as `RepoGroup` renders them.
function pushSessions(
  out: RailNode[],
  repo: RepoData,
  folder: FolderData,
  wins: WindowsPayload | null,
  depth: number,
): void {
  for (const s of railSessionOrder(folder, wins)) {
    out.push({
      key: sessionNodeKey(s.id),
      kind: "session",
      repoKey: repo.key,
      dir: folder.dir,
      sessionId: s.id,
      collapseKey: null,
      depth,
    });
  }
}

function railSessionOrder(folder: FolderData, wins: WindowsPayload | null): SessionData[] {
  const byId = new Map(folder.sessions.map((s) => [s.id, s] as const));
  const folderWins = (wins?.windows ?? []).filter((w) => w.folderDir === folder.dir);
  const grouped = new Set(folderWins.flatMap((w) => w.panes));
  const windowed = folderWins
    .flatMap((w) => w.panes)
    // A window pane may be a diff/files view, which has no session to jump to.
    .map((id) => byId.get(id))
    .filter((s): s is SessionData => s !== undefined);
  return [...windowed, ...folder.sessions.filter((s) => !grouped.has(s.id))];
}
