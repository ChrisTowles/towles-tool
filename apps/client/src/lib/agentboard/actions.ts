import type { TaskOutcome } from "@/lib/data";
import type { LaunchConfigStatus } from "@/lib/launch";
import type { LandingSummary, TaskBlocker } from "./landing";
import type { SessionData } from "./types";

/** All PTY writes — the agent is the real shell, never a re-rendered proxy. */
export type SessionActions = {
  startClaude: (folderDir: string, s: SessionData) => void;
  stopClaude: (s: SessionData) => void;
  compactClaude: (s: SessionData) => void;
  noteAgent: (s: SessionData) => void;
  restartClaude: (folderDir: string, s: SessionData) => void;
  close: (sessionId: string) => void;
  renameStart: (sessionId: string) => void;
  focusWindow: (windowId: string) => void;
  launchDevServer: (folderDir: string, cfg: LaunchConfigStatus) => void;
  focusSession: (folderDir: string, sessionId: string) => void;
};

export type RepoCandidate = { name: string; dir: string; active: boolean };

export type RemoveTarget = {
  label: string;
  dirs: string[];
  sessionIds: string[];
  /** Not on disk, so the dialog asks about closing the task instead. */
  dirMissing?: boolean;
  /** The folder's base override, so the dialog's diff matches the rail's. */
  baseBranch?: string | null;
  /** Carried into the blocked dialog too, so a refusal keeps the context. */
  landing?: LandingSummary;
};

export type BlockedDelete = {
  target: RemoveTarget;
  name: string;
  outcome?: TaskOutcome;
  blockers: TaskBlocker[];
  /** How the verdict was reached (a failed fetch → stale refs), so the dialog
   * can qualify the blockers it lists. */
  messages: string[];
};

/** Awaiting the "what are you working toward?" prompt (`commitStartClaude`). */
export type StartClaudeTarget = {
  folderDir: string;
  sessionId: string;
  sessionName: string;
  restart: boolean;
};
