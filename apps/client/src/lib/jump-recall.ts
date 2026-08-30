/** What the jump keys cost you: Shift+Ctrl+N lands you in a pane that looks
 * like every other pane, so the board says out loud where you are and what was
 * happening here. Pure — the card only renders what this returns. */
import {
  fmtWaitingAge,
  folderLastWorkedAt,
  humanizeFolderName,
  sessionSaid,
  type FolderData,
  type RepoData,
  type SessionData,
} from "./agentboard";
import { fmtAge } from "./data";

export type JumpRecall = {
  sessionId: string;
  /** Re-jumping to the same session must replay the card, not sit on a stale one. */
  nonce: number;
  repo: string;
  /** How the rail names the checkout. */
  title: string;
  branch: string;
  /** The session in its own words — thread title, else the launch prompt. */
  said: string | null;
  /** "waiting 12m" / "errored", or null when nothing flagged it. */
  waiting: string | null;
  errored: boolean;
  /** Work in the tree that exists nowhere else. */
  work: string | null;
  /** When this checkout was last touched — the "how cold is this" fact. */
  lastWorked: string | null;
};

export function buildJumpRecall(
  repos: RepoData[],
  folder: FolderData,
  session: SessionData,
  now: number,
  nonce: number,
): JumpRecall {
  const repo = repos.find((r) => r.folders.some((f) => f.dir === folder.dir));
  const title = folder.isWorktree ? humanizeFolderName(folder.name) : "Root";
  const errored = session.agentState?.status === "error";
  const worked = folderLastWorkedAt(folder);
  return {
    sessionId: session.id,
    nonce,
    repo: repo?.name ?? folder.repoRoot.split("/").pop() ?? "",
    title,
    branch: folder.branch,
    said: sessionSaid(session),
    waiting: errored ? "errored" : fmtWaitingAge(session.needsSinceMs, now),
    errored,
    work: workSummary(folder),
    lastWorked: worked > 0 ? fmtAge(worked, now) : null,
  };
}

function workSummary(folder: FolderData): string | null {
  const bits: string[] = [];
  if (folder.uncommittedFiles > 0) {
    bits.push(`${folder.uncommittedFiles}${folder.uncommittedCapped ? "+" : ""} uncommitted`);
  }
  if (folder.commitsAhead > 0) bits.push(`${folder.commitsAhead} ahead`);
  return bits.length > 0 ? bits.join(" · ") : null;
}
