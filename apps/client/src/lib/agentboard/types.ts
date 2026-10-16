import type { RepoMeta } from "@/lib/repo-identity";

/** The CLI's statuses plus the terminal states. Background agents still out are
 * a count beside it (`details.backgroundAgents`), never a status of their own. */
export type AgentStatus = "idle" | "busy" | "complete" | "error" | "waiting" | "interrupted";

export type SubagentInfo = {
  agentType?: string | null;
  description?: string | null;
  contextUsed?: number | null;
};

export type AgentEventDetails = {
  model?: string | null;
  contextUsed?: number | null;
  contextMax?: number | null;
  cacheExpiresAt?: number | null;
  cacheTtlMs?: number | null;
  lastActivityAt?: number | null;
  subagents?: SubagentInfo[] | null;
  subagentContextUsed?: number | null;
  subagentCount?: number | null;
  backgroundAgents?: number | null;
};

type AgentEvent = {
  agent: string;
  session: string;
  status: AgentStatus;
  ts: number;
  threadName?: string;
  unseen?: boolean;
  details?: AgentEventDetails | null;
};

type NeedsReason = "waitingForInput" | "errored" | "finished";

/** A port the shell saw in `.env` at spawn that the file now claims differently. */
export type PortDrift = { key: string; spawnedPort: number; currentPort: number };

/** One PTY shell. "Agent" is a badge: `agentState` is set when one is detected. */
export type SessionData = {
  id: string;
  name: string;
  createdAt: number;
  live: boolean;
  shellKind?: string | null;
  unseen: boolean;
  needsSinceMs?: number | null;
  needsReason?: NeedsReason | null;
  working: boolean;
  agentState?: AgentEvent | null;
  agents: AgentEvent[];
  purpose?: string | null;
  portDrift?: PortDrift[];
};

export type LandedVia =
  | "merged"
  | "rebase-merged"
  | "squash-merged"
  | "PR merged"
  | "upstream gone";

export type RowTask = {
  id: number;
  status: string;
  branch?: string;
};

/** Why a rail row exists — a record, never a fact about the filesystem. */
type RowRecord =
  /** The one row kind with no task: tracking a repo isn't a unit of work. */
  | { origin: "checkout" }
  /** The user's own work. */
  | { origin: "task"; task: RowTask }
  /** A worktree on disk no task claimed — Claude Code's own, or hand-added. */
  | { origin: "detected"; task: RowTask }
  /** `~`, pinned atop the tree: not a repo, so no git, no tasks, no untrack. */
  | { origin: "home" };

/** Stamped by the app — the only thing that tells a live create from a dead one. */
type RowPhase = { state: "creating"; label: string } | { state: "removing"; label: string };

export type FolderData = {
  name: string;
  dir: string;
  repoRoot: string;
  record: RowRecord;
  phase?: RowPhase;
  dirMissing: boolean;
  branch: string;
  isWorktree: boolean;
  committedFiles: number;
  committedAdded: number;
  committedRemoved: number;
  /** Staged, unstaged and untracked; untracked carry no lines. Never add these
   * to `committed*`. */
  uncommittedFiles: number;
  uncommittedAdded: number;
  uncommittedRemoved: number;
  /** `uncommittedFiles` is a floor: an untracked directory was too large to list
   * (almost always a `.gitignore` gap). The chip shows a `+`. */
  uncommittedCapped: boolean;
  /** HEAD-vs-index totals — the only numbers a bare `git add` moves. */
  stagedFiles: number;
  stagedAdded: number;
  stagedRemoved: number;
  commitsAhead: number;
  commitsBehind: number;
  dirty: boolean;
  commitsUnlanded: number;
  landed: LandedVia | null;
  sessions: SessionData[];
  needs: number;
  baseBranch?: string | null;
  taskBaseBranch?: string | null;
  /** Where this folder's PR merges — outranks `taskBaseBranch` as the baseline. */
  prBaseBranch?: string | null;
  comparedBase?: string;
  computedAtMs?: number;
  /** Newest of `HEAD`'s commit time, the changed paths' mtimes (the only signal
   * that sees an editor-only session) and the last pane opened here. */
  workedAtMs?: number;
  /** Changed paths' newest mtime, 0 when clean. Unlike `workedAtMs`, opening a
   * pane doesn't move it — purely "the files under review changed". */
  worktreeTouchedMs?: number;
  hasPortDrift: boolean;
  /** Gates the rail's dev-servers button; the configs themselves are fetched on
   * demand via `launch_configs`. */
  hasLaunchConfig: boolean;
  quiet: boolean;
};

/** One commit's own line counts — not the folder's cumulative ones. */
export type CommitStat = {
  sha: string;
  subject: string;
  linesAdded: number;
  linesRemoved: number;
};

/** One file of a branch's diff against its merge-base with the base. */
export type BranchDiffFile = {
  path: string;
  oldPath: string | null;
  status: string;
  linesAdded: number;
  linesRemoved: number;
  binary: boolean;
  /** Not committed — lost when the checkout is deleted. */
  uncommitted: boolean;
};

export type BranchDiff = {
  branch: string;
  comparedBase: string;
  commits: CommitStat[];
  files: BranchDiffFile[];
  capped: boolean;
};

/** A checkout plus every rail folder sharing its git common dir, tracked or
 * merely discovered by `git worktree list`. */
export type RepoData = {
  key: string;
  dir: string;
  name: string;
  originUrl?: string | null;
  folders: FolderData[];
  needs: number;
  meta?: RepoMeta;
  color: string;
};

export type Panes = [string, ...string[]];

/** A named tiling of pane ids. A window may never span more than one folder. */
export type AgWindow = {
  id: string;
  name: string;
  folderDir: string;
  panes: Panes;
  cols?: number[];
};

export type WindowsPayload = { windows: AgWindow[]; activeWindows: Record<string, string> };

/** Before parsing: `panes` may be empty in blobs written before empty windows
 * became unrepresentable. */
type WireWindow = Omit<AgWindow, "panes"> & { panes: string[] };

export type WireWindowsPayload = { windows: WireWindow[]; activeWindows: Record<string, string> };

export type StatePayload = {
  repos: RepoData[];
  compactRecommendPercent: number;
  windows: WireWindowsPayload;
  collapsed: Record<string, boolean>;
  /** False when `claude agents` keeps failing: the rows below are missing
   * agents rather than reporting none. */
  agentScanOk: boolean;
  ts: number;
};

export type Selected = { folderDir: string; sessionId: string } | null;
