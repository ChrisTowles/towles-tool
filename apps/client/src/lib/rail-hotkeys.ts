import {
  isSoloRepo,
  type FolderData,
  type RepoData,
  type SessionData,
  type WindowsPayload,
} from "@/lib/agentboard";

/** Digits 1–9; a tenth visible session simply wears no badge. */
export const RAIL_HOTKEY_MAX = 9;

export type RailHotkeyTarget = { sessionId: string; folderDir: string };

// A badge is a promise about a row you can see, so this mirrors the rail's own
// visibility and order — not the flat walk `cycleSession` uses. Collapsed and
// still-folded-quiet rows contribute nothing; a folder's sessions come out
// window-grouped first, then loose, as `RepoGroup` renders them.
export function railHotkeyTargets(args: {
  repos: RepoData[];
  /** Repo key → checkout dirs the rail filter is hiding. */
  quietDirs: Map<string, Set<string>>;
  /** Repo keys whose quiet rows are peeked open. */
  quietRevealed: Set<string>;
  collapsed: Record<string, boolean>;
  wins: WindowsPayload | null;
}): RailHotkeyTarget[] {
  const { repos, quietDirs, quietRevealed, collapsed, wins } = args;
  const out: RailHotkeyTarget[] = [];
  for (const repo of repos) {
    if (out.length >= RAIL_HOTKEY_MAX) break;
    if (collapsed[repo.key]) continue;
    const quiet = quietDirs.get(repo.key);
    const shown =
      !quiet || quietRevealed.has(repo.key)
        ? repo.folders
        : repo.folders.filter((f) => !quiet.has(f.dir));
    for (const folder of shown) {
      // A solo repo has one header for both levels, so only the repo key gates it.
      if (!isSoloRepo(repo) && collapsed[`${repo.key}::${folder.dir}`]) continue;
      for (const s of railSessionOrder(folder, wins)) {
        if (out.length >= RAIL_HOTKEY_MAX) break;
        out.push({ sessionId: s.id, folderDir: folder.dir });
      }
    }
  }
  return out;
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
