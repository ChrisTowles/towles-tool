/** The pane area's no-folder view: the fleet ranked by attention, an axis the
 * repo-grouped rail structurally cannot show. Only a blocked agent earns a row
 * — the rail already states uncommitted work and landed branches. */
import {
  fmtWaitingAge,
  folderHoldsNoWork,
  folderLastWorkedAt,
  humanizeFolderName,
  liveSessions,
  sessionNeeds,
  type FolderData,
  type RepoData,
  type SessionData,
} from "./agentboard";

export type StandbyRow = {
  dir: string;
  title: string;
  repo: string;
  /** What the agent last said about itself, or null when it never spoke. */
  said: string | null;
  note: string;
  errored: boolean;
  /** Epoch ms the wait started, for oldest-first ordering. */
  since: number;
};

export type Standby = {
  /** Blocked checkouts, longest wait first. */
  rows: StandbyRow[];
  /** Counted, never a row: the one state where "where do I go next" is *not there*. */
  working: number;
  total: number;
  /** Checkouts holding work that exists nowhere else (uncommitted or unpushed). */
  holding: number;
  landed: number;
  lastWorkedAt: number;
  lastWorkedName: string | null;
};

/** `now` drives the waiting ages only. */
export function buildStandby(repos: RepoData[], now: number): Standby {
  const rows: StandbyRow[] = [];
  let working = 0;
  let total = 0;
  let holding = 0;
  let landed = 0;
  let lastWorkedAt = 0;
  let lastWorked: FolderData | null = null;

  for (const repo of repos) {
    for (const folder of repo.folders) {
      if (folder.dirMissing) continue;
      total += 1;

      const worked = folderLastWorkedAt(folder);
      if (worked > lastWorkedAt) {
        lastWorkedAt = worked;
        lastWorked = folder;
      }

      const holdsNoWork = folderHoldsNoWork(folder);
      if (!holdsNoWork) holding += 1;
      else if (folder.landed) landed += 1;

      const needing = folder.sessions.filter(sessionNeeds);
      if (needing.length > 0) rows.push(needsRow(repo, folder, needing, now));
      else if (liveSessions(folder).some((s) => s.agentState?.status === "busy")) working += 1;
    }
  }

  rows.sort((a, b) => a.since - b.since);

  return {
    rows,
    working,
    total,
    holding,
    landed,
    lastWorkedAt,
    lastWorkedName: lastWorked && folderTitle(lastWorked),
  };
}

function needsRow(
  repo: RepoData,
  folder: FolderData,
  needing: SessionData[],
  now: number,
): StandbyRow {
  // The longest-blocked session speaks for the whole checkout.
  const oldest = needing.reduce((a, b) =>
    (a.needsSinceMs ?? Infinity) <= (b.needsSinceMs ?? Infinity) ? a : b,
  );
  const errored = needing.some((s) => s.agentState?.status === "error");
  return {
    dir: folder.dir,
    title: folderTitle(folder),
    repo: repo.name,
    said: whatItSaid(oldest),
    note: errored ? "errored" : (fmtWaitingAge(oldest.needsSinceMs, now) ?? "waiting"),
    errored,
    since: oldest.needsSinceMs ?? now,
  };
}

/** How the rail names it: the raw folder name is a branch slug the row's repo
 * prefix would only restate. */
function folderTitle(folder: FolderData): string {
  return folder.isWorktree ? humanizeFolderName(folder.name) : "Root";
}

function whatItSaid(session: SessionData): string | null {
  const thread = session.agentState?.threadName?.trim();
  if (thread && thread !== "Claude Code") return thread;
  const purpose = session.purpose?.trim();
  return purpose && purpose.length > 0 ? purpose : null;
}
