/**
 * What the pane area says when no folder is chosen — the fleet, ranked by how
 * much it wants you.
 *
 * This is the one view the rail structurally cannot give. The rail is a tree
 * grouped by repo, so the two agents blocked on you in *different* repos can
 * never sit next to each other in it; ordering by attention is orthogonal to
 * ordering by repo. Same snapshot, different axis.
 *
 * Only a blocked agent earns a row — uncommitted work and landed branches come
 * back as one counted line, because the rail already states them per checkout
 * with the affordances to act on them.
 */
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

/** One blocked checkout: an agent is stopped and nothing happens until you
 * answer it. */
export type StandbyRow = {
  dir: string;
  title: string;
  repo: string;
  /** What the agent last said about itself, freshest source first, or null when
   * it never said anything — see {@link whatItSaid}. */
  said: string | null;
  /** Right-aligned state: "waiting 12m", or "errored". */
  note: string;
  errored: boolean;
  /** Epoch ms the wait started, for oldest-first ordering. */
  since: number;
};

export type Standby = {
  /** Blocked checkouts, longest wait first. */
  rows: StandbyRow[];
  /** Checkouts with a live agent mid-turn — counted, never a row: this is the
   * one state where the answer to "where do I go next" is *not there*. */
  working: number;
  /** Every checkout on the rail. */
  total: number;
  /** Checkouts holding work that exists nowhere else (uncommitted or unpushed). */
  holding: number;
  /** Checkouts whose branch landed and hold nothing — removable. */
  landed: number;
  /** When anything in the fleet was last worked in, or 0 for a cold fleet. */
  lastWorkedAt: number;
  /** The checkout `lastWorkedAt` came from, for the all-quiet line. */
  lastWorkedName: string | null;
};

/** Rank the fleet. `now` drives the waiting ages only. */
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

  // Longest wait first: an agent blocked twelve minutes outranks one blocked
  // for one, whatever repo either sits in.
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
  // The longest-blocked session speaks for the checkout: its wait is the one
  // you'd end first, and the row clicks through to the folder either way.
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

/** How the rail names this checkout: a de-slugged worktree title, or "Root" for
 * a repo's main checkout. The raw folder name is a branch slug, which the row's
 * repo prefix would only restate. */
function folderTitle(folder: FolderData): string {
  return folder.isWorktree ? humanizeFolderName(folder.name) : "Root";
}

/**
 * The agent's own words about this checkout, freshest first: its Claude thread
 * title, then the prompt it was launched with. Null when it never said
 * anything, so the row carries no second line at all.
 */
function whatItSaid(session: SessionData): string | null {
  const thread = session.agentState?.threadName?.trim();
  if (thread && thread !== "Claude Code") return thread;
  const purpose = session.purpose?.trim();
  return purpose && purpose.length > 0 ? purpose : null;
}
