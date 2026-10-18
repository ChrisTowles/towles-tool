import type { IssueItem } from "@/lib/data";
import { invoke, runIpc } from "@/lib/tauri";

/** A cross-screen handoff — Agentboard may not be mounted when it's made. */
export type PendingOpenSession = {
  folderDir: string;
  sessionId: string;
  resumeId: string;
  label: string;
};

/** A queue: the picker hands off every ticked pane at once, so keeping only
 * the last would resume one session out of N. */
let pendingOpenSessions: PendingOpenSession[] = [];

const openSessionListeners = new Set<(req: PendingOpenSession) => void>();

export function requestOpenSession(req: PendingOpenSession) {
  if (openSessionListeners.size > 0) {
    for (const l of openSessionListeners) l(req);
    return;
  }
  pendingOpenSessions.push(req);
}

export function consumePendingOpenSessions(): PendingOpenSession[] {
  const reqs = pendingOpenSessions;
  pendingOpenSessions = [];
  return reqs;
}

export function onOpenSessionRequest(cb: (req: PendingOpenSession) => void): () => void {
  openSessionListeners.add(cb);
  return () => openSessionListeners.delete(cb);
}

/** A pane the app was running Claude in when it last closed. */
export type ResumeCandidate = {
  folderDir: string;
  paneId: string;
  paneName: string;
  claudeSessionId: string;
  title: string | null;
  lastActiveMs: number;
};

/** Panes to offer resuming from the previous run, however it ended. */
export const resumeCandidates = () => runIpc(invoke<ResumeCandidate[]>("ab_resume_candidates"));

/** A read-only "reveal this in Agentboard" handoff. */
export type AgentboardNav =
  | { kind: "folder"; folderDir: string }
  | { kind: "session"; folderDir: string; sessionId: string }
  /** Pre-fills the new-task form bound to an existing id, so submitting mints a
   * fresh worktree for that task instead of a new card. */
  | {
      kind: "reopen-task";
      repoDir: string;
      repoName: string;
      repoKey: string;
      originUrl?: string;
      taskId: number;
      goal: string;
    }
  /** The Board's watched-issue "Start task": the new-task form, the issue picked. */
  | {
      kind: "new-task-from-issue";
      repoDir: string;
      repoName: string;
      repoKey: string;
      originUrl?: string;
      issue: IssueItem;
    }
  /** No human at the form: mint the worktree and launch an agent immediately. */
  | {
      kind: "start-task";
      repoDir: string;
      repoName: string;
      repoKey: string;
      originUrl?: string;
      taskId: number;
      goal: string;
      branch: string;
      base?: string;
    }
  /** The MCP `preview_file` tool's delivery (`lib/preview-artifact.ts`). */
  | {
      kind: "show-file";
      folderDir: string | null;
      path: string;
      title: string;
      nonce: number;
    }
  /** Claude Sessions' "Open in editor": resume an ended session in the Claude
   * Code extension's panel of `folderDir`'s workbench. */
  | {
      kind: "open-claude-session";
      folderDir: string;
      sessionId: string;
    }
  /** The MCP `file_open` tool and `tt open`'s delivery. `path` is absolute:
   * only the screen knows the folder once `folderDir` is null. */
  | {
      kind: "open-file";
      folderDir: string | null;
      path: string;
      isDir: boolean;
      line: number | null;
      nonce: number;
    }
  /** The global `queue-next` chord: open the queue's head in place. */
  | { kind: "queue-next" };

let pendingNav: AgentboardNav | null = null;

const navListeners = new Set<(req: AgentboardNav) => void>();

export function requestAgentboardNav(req: AgentboardNav) {
  if (navListeners.size > 0) {
    for (const l of navListeners) l(req);
    return;
  }
  pendingNav = req;
}

export function consumePendingAgentboardNav(): AgentboardNav | null {
  const req = pendingNav;
  pendingNav = null;
  return req;
}

export function onAgentboardNavRequest(cb: (req: AgentboardNav) => void): () => void {
  navListeners.add(cb);
  return () => navListeners.delete(cb);
}
