import { Result } from "better-result";
import type { z } from "zod";
import type { PrItem, TaskIssueLink, TaskItem, TaskOutcome } from "./data";
import { ImageTooLarge, type IpcError } from "./errors";
import type { LaunchConfigStatus } from "./launch";
import type { RepoMeta } from "./repo-identity";
import { isEmptyQuery, matchesFilter } from "./settings-filter";
import { TaskBlockerSchema } from "./schemas/task";
import type { RailFilter } from "./settings";
import { invoke } from "./tauri";

/** Client-side view of the agentboard bridge (`crates-tauri/tt-app/src/agentboard.rs`). */

/** `started` is `false` only for a deduped no-op: a sync was already in flight. */
export type RepoSyncResult = {
  started: boolean;
  ok: boolean;
  count: number;
  message?: string | null;
};

/** Sync issues + PRs from GitHub now, bypassing the collector's poll cadence. */
export const abSyncRepo = (dir: string) => invoke<RepoSyncResult>("store_sync_repo", { dir });

export const abSetSessionPurpose = (id: string, text: string | null) =>
  invoke("ab_set_session_purpose", { id, text });

export type AgentStatus = "idle" | "busy" | "complete" | "error" | "waiting" | "interrupted";

export type SubagentInfo = {
  agentType?: string | null;
  description?: string | null;
  contextUsed?: number | null;
};

/** Live details from the transcript tail; only the fields the UI renders. */
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
};

export type AgentEvent = {
  agent: string;
  session: string;
  status: AgentStatus;
  ts: number;
  threadName?: string;
  unseen?: boolean;
  details?: AgentEventDetails | null;
};

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
  agentState?: AgentEvent | null;
  agents: AgentEvent[];
  /** Echo of the launch prompt, so the rail's tooltip can explain the session. */
  purpose?: string | null;
  portDrift?: PortDrift[];
};

export type LandedVia = "merged" | "rebase-merged" | "squash-merged" | "upstream gone";

export type RowTask = {
  id: number;
  status: string;
  branch?: string;
};

/** Why a rail row exists — a record, never a fact about the filesystem. */
export type RowRecord =
  /** The one row kind with no task: tracking a repo isn't a unit of work. */
  | { origin: "checkout" }
  /** The user's own work. */
  | { origin: "task"; task: RowTask }
  /** A worktree on disk no task claimed — Claude Code's own, or hand-added. */
  | { origin: "detected"; task: RowTask };

/** Stamped by the app — the only thing that tells a live create from a dead one. */
export type RowPhase = { state: "creating"; label: string } | { state: "removing"; label: string };

export function folderTask(folder: FolderData): RowTask | undefined {
  return folder.record.origin === "checkout" ? undefined : folder.record.task;
}

export function folderIsUnclaimed(folder: FolderData): boolean {
  return folder.record.origin === "detected";
}

export function folderCreating(folder: FolderData): boolean {
  return folder.phase?.state === "creating";
}

export function folderRemoving(folder: FolderData): boolean {
  return folder.phase?.state === "removing";
}

/** Not on disk and nothing working on it — a failed create, or deleted outside. */
export function folderDetached(folder: FolderData): boolean {
  return folder.record.origin !== "checkout" && folder.dirMissing && !folderBusy(folder);
}

/** The task's own record first: a row with no directory has no git to read from.
 * `undefined` means nothing to rebuild — an unclaimed row isn't the user's. */
export function folderRecreateBranch(
  folder: Pick<FolderData, "record" | "branch">,
): string | undefined {
  if (folder.record.origin !== "task") return undefined;
  return folder.record.task.branch?.trim() || folder.branch.trim() || undefined;
}

/** Being created or removed, so it can't be worked in or acted on. */
export function folderBusy(folder: FolderData): boolean {
  return folder.phase !== undefined;
}

export function folderPhaseLabel(folder: FolderData): string | undefined {
  return folder.phase?.label;
}

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
  /** HEAD-vs-index totals — the only numbers a bare `git add` moves, so the
   * diff pane's refresh key needs them. */
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

/** The one definition of "this folder's working tree changed"; the diff and files
 * panes refetch on it. Counts alone miss an equal-length rewrite, which is why
 * `worktreeTouchedMs` is in the key. */
export function folderStatsKey(folder: FolderData): string {
  return [
    folder.committedFiles,
    folder.committedAdded,
    folder.committedRemoved,
    folder.uncommittedFiles,
    folder.uncommittedAdded,
    folder.uncommittedRemoved,
    // Staging moves neither the HEAD-vs-worktree numbers nor any mtime — these
    // three are how the pane hears about a `git add`, its own or a terminal's.
    folder.stagedFiles,
    folder.stagedAdded,
    folder.stagedRemoved,
    folder.commitsAhead,
    folder.worktreeTouchedMs ?? 0,
  ].join(":");
}

/** The other half: what the diff is measured *against* moved. A rebase or fetch
 * shifts the merge-base while every working-tree stat stays put, so both keys
 * drive `DiffPane`'s refetch. */
export function folderBaseKey(folder: FolderData): string {
  return [folder.commitsAhead, folder.commitsBehind, folder.comparedBase ?? ""].join(":");
}

export function gitCheckedLabel(computedAtMs: number | undefined, now: number): string | null {
  if (!computedAtMs) return null;
  const secs = Math.max(0, Math.round((now - computedAtMs) / 1000));
  if (secs < 60) return `checked ${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `checked ${mins}m ago`;
  return `checked ${Math.round(mins / 60)}h ago`;
}

/** One commit's own line counts — not the folder's cumulative ones. */
export type CommitStat = {
  sha: string;
  subject: string;
  linesAdded: number;
  linesRemoved: number;
};

export function comparedBaseLabel(folder: Pick<FolderData, "comparedBase">): string {
  const base = folder.comparedBase?.trim();
  if (!base) return "main";
  return base.startsWith("origin/") ? base.slice("origin/".length) : base;
}

/** A checkout plus every rail folder sharing its git common dir, tracked or
 * merely discovered by `git worktree list`. */
export type RepoData = {
  key: string;
  /** Also embedded in `key`, as a field so readers never parse it back out. */
  dir: string;
  name: string;
  originUrl?: string | null;
  folders: FolderData[];
  needs: number;
  /** Absent — or absent fields — means "render unthemed": never synthesize a
   * color from the name. */
  meta?: RepoMeta;
};

export type Panes = [string, ...string[]];

function toPanes(ids: string[]): Panes | null {
  return ids.length > 0 ? (ids as Panes) : null;
}

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
export type WireWindow = Omit<AgWindow, "panes"> & { panes: string[] };
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

/** Window identity colors for the rail group tags + window-strip squares. */
const WINDOW_COLORS = [
  "bg-teal-500",
  "bg-fuchsia-500",
  "bg-lime-500",
  "bg-rose-400",
  "bg-indigo-400",
];

export function windowColor(wins: AgWindow[], windowId: string): string {
  const i = wins.findIndex((w) => w.id === windowId);
  return i < 0 ? "bg-muted-foreground/40" : WINDOW_COLORS[i % WINDOW_COLORS.length];
}

// Folder panes. A window's `panes` otherwise hold session ids (`s<16 hex>`).

const DIFF_PANE_PREFIX = "~diff:";
const FILES_PANE_PREFIX = "~files:";
const PREVIEW_PANE_PREFIX = "~preview:";
const JARVIS_PANE_PREFIX = "~jarvis:";
const BROWSER_PANE_PREFIX = "~browser:";
const EXIT_PANE_PREFIX = "~exit:";

export function diffPaneId(folderDir: string): string {
  return `${DIFF_PANE_PREFIX}${folderDir}`;
}

export function isDiffPane(paneId: string): boolean {
  return paneId.startsWith(DIFF_PANE_PREFIX);
}

export function diffPaneDir(paneId: string): string | null {
  return isDiffPane(paneId) ? paneId.slice(DIFF_PANE_PREFIX.length) : null;
}

export function filesPaneId(folderDir: string): string {
  return `${FILES_PANE_PREFIX}${folderDir}`;
}

export function isFilesPane(paneId: string): boolean {
  return paneId.startsWith(FILES_PANE_PREFIX);
}

export function filesPaneDir(paneId: string): string | null {
  return isFilesPane(paneId) ? paneId.slice(FILES_PANE_PREFIX.length) : null;
}

/** Null when the file lives outside the checkout — the files pane can only
 * browse it, so outside paths stay external-editor territory. */
export function filesPanePathFor(folderDir: string, path: string): string | null {
  if (path.startsWith(`${folderDir}/`)) return path.slice(folderDir.length + 1);
  if (path.startsWith("/") || path.startsWith("~")) return null;
  let rel = path;
  while (rel.startsWith("./")) rel = rel.slice(2);
  if (rel === "" || rel.startsWith("../")) return null;
  return rel;
}

export function previewPaneId(folderDir: string): string {
  return `${PREVIEW_PANE_PREFIX}${folderDir}`;
}

export function isPreviewPane(paneId: string): boolean {
  return paneId.startsWith(PREVIEW_PANE_PREFIX);
}

export function previewPaneDir(paneId: string): string | null {
  return isPreviewPane(paneId) ? paneId.slice(PREVIEW_PANE_PREFIX.length) : null;
}

/** A rectangle of the window handed to `tt-jarvis`'s Bevy renderer as a real
 * compositor surface, tiled beside the folder's terminals. */
export function jarvisPaneId(folderDir: string): string {
  return `${JARVIS_PANE_PREFIX}${folderDir}`;
}

export function isJarvisPane(paneId: string): boolean {
  return paneId.startsWith(JARVIS_PANE_PREFIX);
}

export function jarvisPaneDir(paneId: string): string | null {
  return isJarvisPane(paneId) ? paneId.slice(JARVIS_PANE_PREFIX.length) : null;
}

/** A real Chrome on the app-owned profile, streamed onto a canvas. */
export function browserPaneId(folderDir: string): string {
  return `${BROWSER_PANE_PREFIX}${folderDir}`;
}

export function isBrowserPane(paneId: string): boolean {
  return paneId.startsWith(BROWSER_PANE_PREFIX);
}

export function browserPaneDir(paneId: string): string | null {
  return isBrowserPane(paneId) ? paneId.slice(BROWSER_PANE_PREFIX.length) : null;
}

export function folderPaneDir(paneId: string): string | null {
  return (
    diffPaneDir(paneId) ??
    filesPaneDir(paneId) ??
    previewPaneDir(paneId) ??
    jarvisPaneDir(paneId) ??
    browserPaneDir(paneId)
  );
}

export function exitPaneId(sessionId: string): string {
  return `${EXIT_PANE_PREFIX}${sessionId}`;
}

export function isExitPane(paneId: string): boolean {
  return paneId.startsWith(EXIT_PANE_PREFIX);
}

export function exitPaneSession(paneId: string): string | null {
  return isExitPane(paneId) ? paneId.slice(EXIT_PANE_PREFIX.length) : null;
}

/** A session pane is its own id, a tombstone unwraps, folder panes have none. */
export function paneSession(paneId: string): string | null {
  if (folderPaneDir(paneId) !== null) return null;
  return exitPaneSession(paneId) ?? paneId;
}

/** What closing a pane actually means: end the shell behind it, or just drop the tile. */
export type PaneCloseTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "pane"; paneId: string };

/** Null when the ring sits on a pane the visible window doesn't hold: a chord
 * that closes something off-screen loses work. A tombstone closes as a pane. */
export function paneCloseTarget(
  focusedPaneId: string | null,
  panes: readonly string[],
): PaneCloseTarget | null {
  if (!focusedPaneId || !panes.includes(focusedPaneId)) return null;
  const sessionId = isExitPane(focusedPaneId) ? null : paneSession(focusedPaneId);
  return sessionId === null
    ? { kind: "pane", paneId: focusedPaneId }
    : { kind: "session", sessionId };
}

// Pure window-layout reducers; the screen wraps them in `updateWins`.

/** Last id handed out, so a same-millisecond mint can't repeat one. */
let lastWindowSeq = 0;

export function nextWindowId(): string {
  const now = Date.now();
  lastWindowSeq = now > lastWindowSeq ? now : lastWindowSeq + 1;
  return `w${lastWindowSeq}`;
}

let openFileNonce = 0;

/** Monotonic re-trigger token for the code viewer's "open this file at this anchor" effect. */
export function nextOpenFileNonce(): number {
  return ++openFileNonce;
}

let lastDraftScopeSeq = 0;

/** Scope id for a new-task form's image staging dir; same mint as
 * {@link nextWindowId}, so same-millisecond forms can't collide. */
export function nextDraftScopeId(): string {
  const now = Date.now();
  lastDraftScopeSeq = now > lastDraftScopeSeq ? now : lastDraftScopeSeq + 1;
  return `draft-${lastDraftScopeSeq}`;
}

export function placePane(
  w: WindowsPayload,
  folderDir: string,
  paneId: string,
  newWindowId: () => string,
): WindowsPayload {
  const host = w.windows.find((win) => win.panes.includes(paneId));
  if (host) {
    return w.activeWindows[folderDir] === host.id
      ? w
      : { ...w, activeWindows: { ...w.activeWindows, [folderDir]: host.id } };
  }
  let windowId = w.activeWindows[folderDir];
  if (!w.windows.some((win) => win.id === windowId && win.folderDir === folderDir)) {
    // Reuse the folder's first existing window before minting: a dangling active
    // entry would spawn a duplicate "primary" beside the one the user has.
    const existing = w.windows.find((win) => win.folderDir === folderDir);
    if (!existing) {
      // Windows are born around their first pane — never empty.
      const id = newWindowId();
      return {
        windows: [...w.windows, { id, name: "primary", folderDir, panes: [paneId] }],
        activeWindows: { ...w.activeWindows, [folderDir]: id },
      };
    }
    windowId = existing.id;
  }
  return {
    windows: w.windows.map((win) =>
      win.id === windowId ? { ...win, panes: appendPane(win.panes, paneId) } : win,
    ),
    activeWindows: { ...w.activeWindows, [folderDir]: windowId },
  };
}

/** Keeps the non-empty tuple type; a plain spread widens to `string[]`. */
function appendPane(panes: Panes, paneId: string): Panes {
  const [first, ...rest] = panes;
  return [first, ...rest, paneId];
}

export function dropPane(w: WindowsPayload, paneId: string): WindowsPayload {
  const host = w.windows.find((win) => win.panes.includes(paneId));
  if (!host) return w;
  const remaining = toPanes(host.panes.filter((p) => p !== paneId));
  if (!remaining) {
    const sibling = w.windows.find((win) => win.folderDir === host.folderDir && win.id !== host.id);
    const activeWindows = { ...w.activeWindows };
    if (activeWindows[host.folderDir] === host.id) {
      if (sibling) activeWindows[host.folderDir] = sibling.id;
      else delete activeWindows[host.folderDir];
    }
    return { windows: w.windows.filter((win) => win.id !== host.id), activeWindows };
  }
  return {
    ...w,
    windows: w.windows.map((win) => (win.id === host.id ? { ...win, panes: remaining } : win)),
  };
}

/** The neighbor sliding into the closed slot, else the first pane of the sibling
 * window `dropPane` will activate. Null when nothing is left. */
export function successorPane(w: WindowsPayload, paneId: string): string | null {
  const host = w.windows.find((win) => win.panes.includes(paneId));
  if (!host) return null;
  const rest = host.panes.filter((p) => p !== paneId);
  if (rest.length > 0) return rest[Math.min(host.panes.indexOf(paneId), rest.length - 1)];
  const sibling = w.windows.find((win) => win.folderDir === host.folderDir && win.id !== host.id);
  return sibling?.panes[0] ?? null;
}

/** Swap one pane id for another in place — same window, same position, same column widths. */
export function replacePane(w: WindowsPayload, fromId: string, toId: string): WindowsPayload {
  const host = w.windows.find((win) => win.panes.includes(fromId));
  if (!host) return w;
  const swap = (p: string) => (p === fromId ? toId : p);
  return {
    ...w,
    windows: w.windows.map((win) => {
      if (win.id !== host.id) return win;
      // Rebuilt head-first so the non-empty tuple type survives the map.
      const [first, ...rest] = win.panes;
      return { ...win, panes: [swap(first), ...rest.map(swap)] };
    }),
  };
}

/** Exactly the `touchedFolders` the backend's merge-by-folder save needs. */
export function changedFolderDirs(a: WireWindowsPayload, b: WireWindowsPayload): string[] {
  const dirs = new Set<string>([
    ...a.windows.map((win) => win.folderDir),
    ...b.windows.map((win) => win.folderDir),
    ...Object.keys(a.activeWindows),
    ...Object.keys(b.activeWindows),
  ]);
  return [...dirs].filter((d) => folderSignature(a, d) !== folderSignature(b, d));
}

function folderSignature(p: WireWindowsPayload, dir: string): string {
  return JSON.stringify([
    p.windows.filter((win) => win.folderDir === dir),
    p.activeWindows[dir] ?? null,
  ]);
}

export function hydrateWins(w: WireWindowsPayload): WindowsPayload {
  const windows: AgWindow[] = [];
  for (const win of w.windows) {
    const panes = toPanes(win.panes.filter((p) => folderPaneDir(p) !== null));
    if (panes) windows.push({ ...win, panes });
  }
  return normalizeWins({ windows, activeWindows: w.activeWindows });
}

/** Reconcile the persisted layout against what actually exists. */
export function pruneWins(
  w: WindowsPayload,
  validSessionIds: ReadonlySet<string>,
  validFolderDirs: ReadonlySet<string>,
): WindowsPayload {
  const kept: AgWindow[] = [];
  for (const win of w.windows) {
    if (!validFolderDirs.has(win.folderDir)) continue;
    const panes = toPanes(
      win.panes.filter((p) => {
        const dir = folderPaneDir(p);
        if (dir !== null) return validFolderDirs.has(dir);
        // A tombstone dies with the session it reports on — nothing left to name.
        return validSessionIds.has(paneSession(p)!);
      }),
    );
    if (!panes) continue;
    kept.push(panes.length === win.panes.length ? win : { ...win, panes });
  }
  const activeWindows: Record<string, string> = {};
  for (const win of kept) {
    if (win.folderDir in activeWindows) continue;
    const cur = w.activeWindows[win.folderDir];
    activeWindows[win.folderDir] =
      cur && kept.some((x) => x.folderDir === win.folderDir && x.id === cur) ? cur : win.id;
  }
  const next = { windows: kept, activeWindows };
  return changedFolderDirs(w, next).length === 0 ? w : next;
}

export function isAgent(s: SessionData): boolean {
  return s.agentState != null;
}

/** Requires a live PTY — anything else is a stale record whose agent status
 * can't be current — plus an agent blocked, errored, or done and unseen. */
export function sessionNeeds(s: SessionData): boolean {
  if (!s.live) return false;
  const st = s.agentState?.status;
  if (st === "waiting" || st === "error") return true;
  return s.unseen && (st === "complete" || st === "interrupted");
}

/** Needs you now, or reached a terminal state you haven't acknowledged. */
export function sessionCatchesEye(s: SessionData): boolean {
  return sessionNeeds(s) || s.unseen;
}

export function fmtWaitingAge(sinceMs: number | null | undefined, now: number): string | null {
  if (sinceMs == null) return null;
  const diff = now - sinceMs;
  if (diff < 0) return null;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "waiting <1m";
  if (mins < 60) return `waiting ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `waiting ${hrs}h`;
  return `waiting ${Math.floor(hrs / 24)}d`;
}

/** Free to pick up: an agent that isn't working, or a flagged session. A plain
 * shell stays out — it was never an agent to be idle. */
export function sessionNotBusy(s: SessionData): boolean {
  if (s.agentState?.status === "busy") return false;
  return isAgent(s) || sessionCatchesEye(s);
}

export function cycleNeedsYou(
  repos: RepoData[],
  fromSessionId: string | null,
  direction: "next" | "prev",
): SessionData | null {
  return cycleWhere(repos, fromSessionId, direction, sessionCatchesEye);
}

export function cycleNotBusy(
  repos: RepoData[],
  fromSessionId: string | null,
  direction: "next" | "prev",
): SessionData | null {
  return cycleWhere(repos, fromSessionId, direction, sessionNotBusy);
}

function cycleWhere(
  repos: RepoData[],
  fromSessionId: string | null,
  direction: "next" | "prev",
  match: (s: SessionData) => boolean,
): SessionData | null {
  const all: SessionData[] = [];
  for (const r of repos) for (const f of r.folders) for (const s of f.sessions) all.push(s);

  const targetIndexes = all.map((s, i) => (match(s) ? i : -1)).filter((i) => i !== -1);
  if (targetIndexes.length === 0) return null;

  const fromIndex = fromSessionId ? all.findIndex((s) => s.id === fromSessionId) : -1;

  const chosen =
    direction === "next"
      ? (targetIndexes.find((i) => i > fromIndex) ?? targetIndexes[0])
      : ([...targetIndexes].toReversed().find((i) => i < fromIndex) ??
        targetIndexes[targetIndexes.length - 1]);

  return all[chosen];
}

export function cycleSession(
  repos: RepoData[],
  fromSessionId: string | null,
  direction: "next" | "prev",
): SessionData | null {
  const all: SessionData[] = [];
  for (const r of repos) for (const f of r.folders) for (const s of f.sessions) all.push(s);
  if (all.length === 0) return null;

  const fromIndex = fromSessionId ? all.findIndex((s) => s.id === fromSessionId) : -1;

  if (direction === "next") {
    return fromIndex === -1 ? all[0] : all[(fromIndex + 1) % all.length];
  }
  return fromIndex === -1 ? all[all.length - 1] : all[(fromIndex - 1 + all.length) % all.length];
}

export function liveSessions(folder: FolderData): SessionData[] {
  return folder.sessions.filter((s) => s.live);
}

/** Deduped by key + spawned/current pair: panes spawned at different times can
 * carry the same drift, or different ones if a port rotated twice. */
export function folderPortDrift(folder: Pick<FolderData, "sessions">): PortDrift[] {
  const seen = new Map<string, PortDrift>();
  for (const s of folder.sessions) {
    for (const d of s.portDrift ?? []) {
      seen.set(`${d.key}:${d.spawnedPort}:${d.currentPort}`, d);
    }
  }
  return [...seen.values()];
}

/** An agent's thread name when it has one, so the row reads as *the agent*. */
export function sessionLabel(s: SessionData): string {
  const thread = s.agentState?.threadName?.trim();
  return thread && thread.length > 0 ? thread : s.name;
}

export function claudeTitleName(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/^\s*✳\s*(.+?)\s*$/u);
  if (!m || m[1] === "Claude Code") return null;
  return m[1];
}

/** A one-word status label for a session row. */
export function sessionStatusText(s: SessionData): string {
  if (!s.live) return "Off";
  const st = s.agentState;
  if (!st) return "Idle";
  switch (st.status) {
    case "waiting":
      return "Waiting";
    case "error":
      return "Error";
    case "busy":
      return "Working";
    case "complete":
      return "Done";
    case "interrupted":
      return "Paused";
    default:
      return "Idle";
  }
}

/** True when a repo's single folder should collapse into one rail header. */
export function isSoloRepo(r: RepoData): boolean {
  return r.folders.length === 1;
}

/** The rail minus its quiet checkouts, plus what was taken out. "Mark quiet"
 * is a hide, not a demotion, and it ignores the rail filter — under the
 * default `"all"` a filter-shaped quiet would do nothing at all. The checkout
 * you are working in is never taken, and `show` (the rail header's toggle)
 * puts them all back. `quietDirs` reports the marks either way, so a row shown
 * anyway can still say it is quiet, and the header can count them. */
export function partitionQuiet(
  repos: RepoData[],
  args: { show: boolean; activeFolderDir: string | null },
): { shown: RepoData[]; quietDirs: Map<string, Set<string>>; quietCount: number } {
  const quietDirs = new Map<string, Set<string>>();
  let quietCount = 0;
  for (const r of repos) {
    const dirs = new Set(
      r.folders.filter((f) => f.quiet && f.dir !== args.activeFolderDir).map((f) => f.dir),
    );
    if (dirs.size === 0) continue;
    quietDirs.set(r.key, dirs);
    quietCount += dirs.size;
  }
  if (args.show || quietCount === 0) return { shown: repos, quietDirs, quietCount };
  const shown = repos
    .map((r) => {
      const dirs = quietDirs.get(r.key);
      return dirs ? { ...r, folders: r.folders.filter((f) => !dirs.has(f.dir)) } : r;
    })
    .filter((r) => r.folders.length > 0);
  return { shown, quietDirs, quietCount };
}

/** The rail narrowed to what a typed query matches. A repo matched by *name*
 * keeps every checkout — you asked for the repo, not one branch in it. Branch
 * and the de-slugged title count, since that is what a worktree row reads as;
 * paths don't, or every `~/code/p` checkout would answer to "p". */
export function searchRepos(repos: RepoData[], query: string): RepoData[] {
  if (isEmptyQuery(query)) return repos;
  const kept: RepoData[] = [];
  for (const r of repos) {
    if (matchesFilter(query, r.name)) {
      kept.push(r);
      continue;
    }
    const folders = r.folders.filter((f) =>
      matchesFilter(query, f.name, [f.branch, humanizeFolderName(f.name)]),
    );
    if (folders.length > 0) kept.push({ ...r, folders });
  }
  return kept;
}

/** One cursor, three levels — Ctrl+Shift+arrows move whatever is focused. */
export type FocusLevel = "rail" | "window" | "pane";

export type FocusMove =
  | { kind: "session"; direction: "next" | "prev" }
  | { kind: "level"; level: FocusLevel }
  | { kind: "pane"; id: string }
  | { kind: "window"; id: string };

// Right descends rail → window strip → panes, skipping the window level for a
// single-window folder; Left and Up climb back out, ending on the rail.
export function moveFocus(args: {
  level: FocusLevel;
  direction: "up" | "down" | "left" | "right";
  panes: readonly string[];
  focusedPaneId: string | null;
  windows: readonly string[];
  activeWindowId: string | null;
}): FocusMove | null {
  const { level, direction, panes, focusedPaneId, windows, activeWindowId } = args;
  const multiWin = windows.length > 1;
  const firstPane = (): FocusMove | null =>
    panes.length > 0 ? { kind: "pane", id: panes[0] } : null;

  if (level === "rail") {
    if (direction === "up") return { kind: "session", direction: "prev" };
    if (direction === "down") return { kind: "session", direction: "next" };
    if (direction === "right") return multiWin ? { kind: "level", level: "window" } : firstPane();
    return null;
  }

  if (level === "window") {
    const wi = activeWindowId ? windows.indexOf(activeWindowId) : -1;
    if (direction === "up") return { kind: "level", level: "rail" };
    if (direction === "down") return firstPane();
    if (direction === "right") {
      return wi >= 0 && wi < windows.length - 1 ? { kind: "window", id: windows[wi + 1] } : null;
    }
    return wi > 0 ? { kind: "window", id: windows[wi - 1] } : { kind: "level", level: "rail" };
  }

  const idx = focusedPaneId ? panes.indexOf(focusedPaneId) : -1;
  if (direction === "right" || direction === "down") {
    if (idx === -1) return firstPane();
    return idx < panes.length - 1 ? { kind: "pane", id: panes[idx + 1] } : null;
  }
  if (direction === "left" && idx > 0) return { kind: "pane", id: panes[idx - 1] };
  return { kind: "level", level: multiWin ? "window" : "rail" };
}

/** Grace after the last sign of agent life, so stopping a session doesn't make
 * a folder vanish from the rail the same instant. */
export const IDLE_GRACE_MS = 45 * 60_000;

export function folderLastActivityAt(f: FolderData): number {
  let last = 0;
  for (const s of f.sessions) {
    for (const ev of [s.agentState, ...s.agents]) {
      if (!ev) continue;
      last = Math.max(last, ev.ts, ev.details?.lastActivityAt ?? 0);
    }
  }
  return last;
}

/** Nothing here needs attention: no live or eye-catching session, nothing
 * unpushed or dirty, and no agent activity inside `IDLE_GRACE_MS`. The rail
 * *filter*'s question — {@link FolderData.quiet}, the hand mark, is not part of
 * it: that one hides the checkout outright, whatever the filter says. */
export function isFolderIdle(f: FolderData, now: number): boolean {
  return (
    liveSessions(f).length === 0 &&
    f.uncommittedFiles === 0 &&
    f.commitsAhead === 0 &&
    f.sessions.every((s) => !sessionCatchesEye(s)) &&
    now - folderLastActivityAt(f) >= IDLE_GRACE_MS
  );
}

/** {@link FolderData.workedAtMs} plus the agent activity only the client sees. */
export function folderLastWorkedAt(f: FolderData): number {
  return Math.max(folderLastActivityAt(f), f.workedAtMs ?? 0);
}

/** Whether a folder falls outside the "worked in the last `hours` hours" window. */
export function isFolderStale(f: FolderData, now: number, hours: number): boolean {
  if (liveSessions(f).length > 0) return false;
  return now - folderLastWorkedAt(f) >= hours * 3_600_000;
}

/** Whether `filter` demotes this folder to the per-repo "N idle" stub row. */
export function isFolderFiltered(
  f: FolderData,
  filter: RailFilter,
  now: number,
  recentHours: number,
): boolean {
  switch (filter) {
    case "all":
      return false;
    case "active":
      return isFolderIdle(f, now);
    case "recent":
      return isFolderStale(f, now, recentHours);
  }
}

export function pathScope(dir: string): string | null {
  const m = dir.match(/\/code\/([a-z])\//);
  return m ? `${m[1]}/` : null;
}

/** PR rows carry gh's `owner/name`, which both https and ssh origins contain. */
export function ownerRepoFromOrigin(originUrl: string | null | undefined): string | undefined {
  if (!originUrl) return undefined;
  const match = originUrl.trim().match(/[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!match) return undefined;
  return `${match[1]}/${match[2]}`;
}

export function prForFolder(
  prs: PrItem[],
  originUrl: string | null | undefined,
  branch: string,
): PrItem | undefined {
  if (!branch) return undefined;
  const origin = originUrl?.toLowerCase();
  return prs.find((p) => p.branch === branch && (!origin || origin.includes(p.repo.toLowerCase())));
}

/** The one link from a rail folder back to its board task, via `worktree.dir`. */
export function taskForFolder(tasks: TaskItem[], dir: string): TaskItem | undefined {
  return tasks.find((t) => t.worktree?.dir === dir);
}

export function issuesForFolder(tasks: TaskItem[], dir: string): TaskIssueLink[] {
  return taskForFolder(tasks, dir)?.issues ?? [];
}

/** A pure git fact, and only *half* of {@link folderSafeToDelete}'s gate. */
export function folderHoldsNoWork(folder: Pick<FolderData, "dirty" | "commitsUnlanded">): boolean {
  return !folder.dirty && folder.commitsUnlanded === 0;
}

/** Safe to delete: its PR merged, *and* nothing here would be lost. */
export function folderSafeToDelete(
  folder: Pick<FolderData, "dirty" | "commitsUnlanded">,
  pr: Pick<PrItem, "state"> | undefined,
): boolean {
  return pr?.state === "merged" && folderHoldsNoWork(folder);
}

/** Proven by git itself (merge, rebase or squash alike) or by a merged PR. */
export function folderLanded(
  folder: Pick<FolderData, "landed">,
  pr: Pick<PrItem, "state"> | undefined,
): boolean {
  return folder.landed !== null || pr?.state === "merged";
}

/** Whether the delete-worktree affordances apply to a folder. */
export function folderRemovableTask(
  folder: Pick<FolderData, "record" | "isWorktree" | "dirMissing">,
): boolean {
  if (folder.record.origin !== "checkout") return true;
  return folder.isWorktree && !folder.dirMissing;
}

const TASK_BLOCKER_KINDS = ["dirtyTree", "unreachableCommits", "foreignPort"] as const;
export type TaskBlockerKind = (typeof TASK_BLOCKER_KINDS)[number];

export type TaskBlocker = z.infer<typeof TaskBlockerSchema>;

export type { TaskDeleteOutcome } from "./schemas/task";

/** What forcing past a blocker would discard, as a noun for the button. */
const DISCARDED: Record<string, string> = {
  dirtyTree: "changes",
  unreachableCommits: "commits",
};

/** Label for the force button in the blocked-delete dialog. */
export function forceDeleteLabel(blockers: TaskBlocker[]): string {
  const nouns = blockers
    .filter((b) => b.losesWork)
    .map((b) => DISCARDED[b.kind])
    .filter((noun): noun is string => noun !== undefined);
  const unique = [...new Set(nouns)];
  return unique.length > 0 ? `Delete and discard the ${unique.join(" and ")}` : "Delete anyway";
}

/** The port this blocker offers to clear, or `null` when there's nothing to act on. */
export function stoppablePort(blocker: TaskBlocker): number | null {
  if (blocker.kind !== "foreignPort") return null;
  return typeof blocker.port === "number" ? blocker.port : null;
}

/** Landed, yet the checkout still holds uncommitted or unlanded work. */
export function folderLandedButHasWork(
  folder: Pick<FolderData, "dirty" | "commitsUnlanded" | "landed">,
  pr: Pick<PrItem, "state"> | undefined,
): boolean {
  return folderLanded(folder, pr) && !folderHoldsNoWork(folder);
}

/** A per-folder actionable signal. */
export type ActionableKind = "safe-to-delete" | "needs-you" | "port-drift";

export type ActionableItem = {
  kind: ActionableKind;
  subtitle: string;
  pr?: Pick<PrItem, "number" | "url">;
};

/** The same gates the rail's badges use, in one list. */
export function folderActionableItems(
  folder: Pick<
    FolderData,
    "isWorktree" | "dirty" | "commitsUnlanded" | "landed" | "comparedBase" | "needs" | "sessions"
  >,
  pr: PrItem | undefined,
): ActionableItem[] {
  const items: ActionableItem[] = [];

  const merged = pr?.state === "merged" ? pr : undefined;
  if (merged && folder.isWorktree && folderSafeToDelete(folder, pr)) {
    const how = folder.landed
      ? `PR #${merged.number} merged, ${folder.landed} into ${comparedBaseLabel(folder)}`
      : `PR #${merged.number} merged`;
    items.push({
      kind: "safe-to-delete",
      subtitle: `${how}, no uncommitted changes, every commit landed`,
      pr: { number: merged.number, url: merged.url },
    });
  }

  if (folder.needs > 0) {
    items.push({
      kind: "needs-you",
      subtitle: `${folder.needs} session${folder.needs === 1 ? "" : "s"} waiting on you`,
    });
  }

  const drift = folderPortDrift(folder);
  if (drift.length > 0) {
    items.push({
      kind: "port-drift",
      subtitle: drift.map((d) => `${d.key} ${d.spawnedPort} → ${d.currentPort}`).join(", "),
    });
  }

  return items;
}

/** `0:04` / `3:20` / `1:02:30` — elapsed duration since a session started. */
export function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Cache & context health (Tier 3)

/** Percent of the context window used (0 when unknown). */
export function ctxPct(d: AgentEventDetails | null | undefined): number {
  if (!d?.contextUsed || !d.contextMax) return 0;
  return Math.round((d.contextUsed / d.contextMax) * 100);
}

/** Token counts at a glance: `53K`, `412K`, `1M`. */
export function fmtTokens(n: number): string {
  if (n < 1_000) return `${n}`;
  const k = Math.round(n / 1_000);
  // Promote on the *rounded* value: 999_500 rounds to 1000K, which reads as 1M.
  if (k < 1_000) return `${k}K`;
  const m = Math.round(n / 100_000) / 10;
  // 1M, not 1.0M — but keep 1.5M's fraction. Tested after rounding.
  return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
}

/** Diff magnitudes for a rail chip: `847`, `12.3K`, `1.2M`. */
export function fmtDiffLines(n: number): string {
  if (n < 10_000) return `${n}`;
  const k = n / 1_000;
  if (k < 100) return `${Math.round(k * 10) / 10}K`;
  // Promote on the *rounded* value, like `fmtTokens`.
  const rounded = Math.round(k);
  if (rounded < 1_000) return `${rounded}K`;
  const m = Math.round(n / 100_000) / 10;
  return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
}

/** `412K / 1M`. Null without a window size — a bare used-count answers nothing. */
export function fmtContext(d: AgentEventDetails | null | undefined): string | null {
  if (!d?.contextMax) return null;
  if (!d.contextUsed) return `${fmtTokens(d.contextMax)} window`;
  return `${fmtTokens(d.contextUsed)} / ${fmtTokens(d.contextMax)}`;
}

/** `claude-opus-4-8 · 412K / 1M` — what a cold resume would cost. */
export function modelContextLabel(d: AgentEventDetails | null | undefined): string | null {
  const parts = [d?.model, fmtContext(d)].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** A task's directory *is* its branch slug, so printing both says it twice. */
export function branchRedundant(folderName: string, branch: string | null | undefined): boolean {
  if (!branch) return false;
  const slug = branch
    .toLowerCase()
    .trim()
    .replace(/[^0-9a-z_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/-+$/, "");
  return folderName === slug;
}

/** Stripped before humanizing, so the name reads as a sentence rather than
 * "Feat today we use…". */
const FOLDER_NAME_PREFIXES = new Set([
  "feat",
  "fix",
  "chore",
  "docs",
  "refactor",
  "test",
  "perf",
  "build",
  "ci",
  "style",
]);

/** Render-time-only fallback for a folder with no bound task title. */
export function humanizeFolderName(folderName: string): string {
  const parts = folderName.split("-").filter(Boolean);
  if (parts.length > 1 && FOLDER_NAME_PREFIXES.has(parts[0].toLowerCase())) {
    parts.shift();
  }
  if (parts.length === 0) return folderName;
  const words = parts.join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function modelLetter(model: string | null | undefined): string | null {
  if (!model) return null;
  const family = ["haiku", "sonnet", "opus", "fable", "mythos"].find((f) =>
    model
      .toLowerCase()
      .split(/[-_./:\s]/)
      .includes(f),
  );
  return family ? family[0].toUpperCase() : null;
}

/** A session is cache-cold when it never had cache activity or the TTL lapsed. */
export function isCold(d: AgentEventDetails | null | undefined, now: number): boolean {
  return !d?.cacheExpiresAt || now >= d.cacheExpiresAt;
}

/** Headroom to nudge the session — any request re-warms the cache — before a
 * resume goes full-price. */
export function cacheWarnMs(ttlMs: number | null | undefined): number {
  return ttlMs === 3_600_000 ? 600_000 : 120_000;
}

/** Still warm, but inside the warn window — one nudge away from going cold. */
export function isCacheExpiring(d: AgentEventDetails | null | undefined, now: number): boolean {
  if (!d?.cacheExpiresAt || isCold(d, now)) return false;
  return d.cacheExpiresAt - now <= cacheWarnMs(d.cacheTtlMs);
}

/** Named, not numeric, so a pane and its tooltip can't disagree about a percent. */
export type ContextBand = "calm" | "noted" | "half" | "heavy" | "critical";

const CONTEXT_BANDS: [number, ContextBand][] = [
  [80, "critical"],
  [60, "heavy"],
  [40, "half"],
  [20, "noted"],
];

export function contextBand(pct: number): ContextBand {
  return CONTEXT_BANDS.find(([floor]) => pct >= floor)?.[1] ?? "calm";
}

export const CONTEXT_BAND_ADVICE: Record<ContextBand, string> = {
  calm: "plenty of room",
  noted: "a fifth of the window is in play",
  half: "the window is filling — cheap to split the work now",
  heavy: "long sessions cost more every turn, cached or not",
  critical: "/compact mid-task, or /clear when switching to new work",
};

/** Its own context plus every sub-agent's — they run their own requests, which
 * the session's `contextUsed` never sees. */
export function sessionTotalTokens(d: AgentEventDetails | null | undefined): number {
  return (d?.contextUsed ?? 0) + (d?.subagentContextUsed ?? 0);
}

export function hasSubagentSpend(d: AgentEventDetails | null | undefined): boolean {
  return (d?.subagentCount ?? 0) > 0 && (d?.subagentContextUsed ?? 0) > 0;
}

/** Sub-agent meta is optional, hence the positional fallback. */
export function subagentLabel(s: SubagentInfo, index: number): string {
  return s.agentType?.trim() || s.description?.trim() || `sub ${index + 1}`;
}

/** Cold AND over threshold: warm-and-huge is fine, the cost bites on resume. */
export function needsCompact(
  d: AgentEventDetails | null | undefined,
  now: number,
  thresholdPct: number,
): boolean {
  return d != null && ctxPct(d) >= thresholdPct && isCold(d, now);
}

export type AgentRollup = {
  total: number;
  busy: number;
  waiting: number;
  error: number;
  compact: number;
  expiring: number;
};

export function agentRollup(
  repos: RepoData[],
  now: number,
  compactThresholdPct: number,
): AgentRollup {
  const r: AgentRollup = { total: 0, busy: 0, waiting: 0, error: 0, compact: 0, expiring: 0 };
  for (const repo of repos)
    for (const f of repo.folders)
      for (const s of f.sessions) {
        const st = s.agentState?.status;
        if (!st) continue;
        r.total += 1;
        if (st === "busy") r.busy += 1;
        else if (st === "waiting") r.waiting += 1;
        else if (st === "error") r.error += 1;
        if (needsCompact(s.agentState?.details, now, compactThresholdPct)) r.compact += 1;
        if (isCacheExpiring(s.agentState?.details, now)) r.expiring += 1;
      }
  return r;
}

/** Same precedence as a collapsed rail row, so the two never disagree. */
export function rollupAlertColor(r: AgentRollup): string | null {
  if (r.error > 0) return "bg-red-500";
  if (r.waiting > 0) return "bg-blue-500";
  if (r.busy > 0) return "bg-cyan-500";
  if (r.total > 0) return "bg-emerald-500";
  return null;
}

/** White reads fine on every fill but cyan-500, where it's nearly illegible. */
export function rollupAlertTextColor(bg: string | null): string {
  return bg === "bg-cyan-500" ? "text-cyan-950" : "text-white";
}

/** The live agentboard state, shared across the app from a single subscription. */
export { useAgentboardState } from "./agentboard-state";

/** Status dot color, mirroring the Rust `AgentStatus::color` intent. */
export function statusColor(status: AgentStatus): string {
  switch (status) {
    case "busy":
      return "bg-cyan-500";
    case "complete":
      return "bg-green-500";
    case "error":
      return "bg-red-500";
    case "waiting":
      return "bg-blue-500";
    case "interrupted":
      return "bg-orange-800";
    default:
      return "bg-muted-foreground/40";
  }
}

/** Ambient color for sessions hidden behind a collapse; emerald means live. */
export function collapsedLiveColor(sessions: SessionData[]): string | null {
  const live = sessions.filter((s) => s.live);
  if (live.length === 0) return null;
  if (live.some((s) => s.agentState?.status === "error")) return "bg-red-500";
  if (live.some((s) => s.agentState?.status === "waiting")) return "bg-blue-500";
  if (live.some((s) => s.agentState?.status === "busy")) return "bg-cyan-500";
  return "bg-emerald-500";
}

// Session PTY writes

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const termWrite = (termId: string, data: string) => invoke<void>("term_write", { termId, data });

/** Retries while the PTY spawns — `term_start` registers a beat after mount. */
export async function termWriteRetry(
  termId: string,
  data: string,
): Promise<Result<void, IpcError>> {
  let last = await termWrite(termId, data);
  for (let i = 1; i < 20 && last.isErr(); i++) {
    await sleep(150);
    last = await termWrite(termId, data);
  }
  return last;
}

/** The shell's first output — the only proof the PTY is reading input. A bare
 * `term_write` can still race the shell sourcing its rc files. */
export async function waitForFirstFrame(termId: string, timeoutMs = 5000): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const { listen } = await import("@tauri-apps/api/event");
  await new Promise<void>((resolve) => {
    let settled = false;
    let unlisten: (() => void) | undefined;
    const timer = setTimeout(finish, timeoutMs);
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unlisten?.();
      resolve();
    }
    listen<{ termId: string }>("terminal://frame", (e) => {
      if (e.payload.termId === termId) finish();
    }).then((u) => (settled ? u() : (unlisten = u)));
  });
}

/** POSIX `'...'` escaping for a command typed into a PTY. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export type ClaudeModel = "sonnet" | "opus" | "fable";

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type ClaudeLaunchOptions = {
  model?: ClaudeModel;
  effort?: ClaudeEffort;
};

/** The prompt goes in as an argument so Claude starts on it immediately. */
export function claudeCommand(prompt: string, options?: ClaudeLaunchOptions): string {
  const trimmed = prompt.trim();
  const parts = [
    "claude",
    options?.model ? `--model ${shellQuote(options.model)}` : null,
    options?.effort ? `--effort ${shellQuote(options.effort)}` : null,
    trimmed ? shellQuote(trimmed) : null,
  ].filter((p): p is string => p != null);
  return `${parts.join(" ")}\r`;
}

const PASTEABLE_IMAGE_MIMES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];

export function isPasteableImage(mime: string): boolean {
  return PASTEABLE_IMAGE_MIMES.includes(mime.split(";")[0].trim().toLowerCase());
}

const MAX_PASTED_IMAGE_BYTES = 10 * 1024 * 1024;

export type PastedImage = {
  id: string;
  name: string;
  mime: string;
  dataBase64: string;
  previewUrl: string;
};

/** Pull every image off a paste/drop's `DataTransfer`, decoded to base64. */
export async function imagesFromDataTransfer(
  data: DataTransfer | null,
): Promise<Result<PastedImage[], ImageTooLarge>> {
  const files = Array.from(data?.items ?? [])
    .filter((it) => it.kind === "file" && isPasteableImage(it.type))
    .map((it) => it.getAsFile())
    .filter((f): f is File => f != null);
  const tooBig = files.find((f) => f.size > MAX_PASTED_IMAGE_BYTES);
  if (tooBig) {
    return Result.err(
      new ImageTooLarge({
        name: tooBig.name || "that image",
        bytes: tooBig.size,
        limitBytes: MAX_PASTED_IMAGE_BYTES,
      }),
    );
  }
  return Result.ok(await Promise.all(files.map((file, i) => readImageFile(file, i))));
}

export async function clipboardImageFromHost(): Promise<PastedImage | null> {
  const result = await invoke<{ mime: string; dataBase64: string } | null>("read_clipboard_image");
  const image = result.unwrapOr(null);
  if (!image) return null;
  return {
    id: `clipboard-${image.dataBase64.length}`,
    name: "clipboard image",
    mime: image.mime,
    dataBase64: image.dataBase64,
    previewUrl: `data:${image.mime};base64,${image.dataBase64}`,
  };
}

async function readImageFile(file: File, index: number): Promise<PastedImage> {
  const previewUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("couldn't read the pasted image")),
    );
    reader.readAsDataURL(file);
  });
  return {
    // Clipboard images are always `image.png`; the index keeps React keys apart.
    id: `${file.name || "pasted"}-${index}-${previewUrl.length}-${file.size}`,
    name: file.name || `pasted-image-${index + 1}`,
    mime: file.type,
    dataBase64: previewUrl.slice(previewUrl.indexOf(",") + 1),
    previewUrl,
  };
}

/** Fold images pasted into the new-task form into that task's opening prompt. */
export function promptWithImages(goal: string, imagePaths: string[]): string {
  const trimmed = goal.trim();
  if (imagePaths.length === 0) return trimmed;
  const one = imagePaths.length === 1;
  const attachment = `Attached ${one ? "image" : "images"} — read ${
    one ? "it" : "them"
  } first, before anything else: ${imagePaths.join(" ")}`;
  return trimmed ? `${trimmed} — ${attachment}` : attachment;
}

/** Resume a past session in place, typed into the folder's PTY. */
export function claudeResumeCommand(sessionId: string): string {
  return `claude --resume ${shellQuote(sessionId)}\r`;
}

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
export const resumeCandidates = () => invoke<ResumeCandidate[]>("ab_resume_candidates");

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
  /** The MCP `file_open` tool and `tt open`'s delivery. `path` is absolute:
   * only the screen knows the folder once `folderDir` is null. */
  | {
      kind: "open-file";
      folderDir: string | null;
      path: string;
      isDir: boolean;
      line: number | null;
      nonce: number;
    };

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

// Session lifecycle + layout shared types

/** All PTY writes — the agent is the real shell, never a re-rendered proxy. */
export type SessionActions = {
  start: (folderDir: string, s: SessionData) => void;
  startClaude: (folderDir: string, s: SessionData) => void;
  stopClaude: (s: SessionData) => void;
  compactClaude: (s: SessionData) => void;
  restartClaude: (folderDir: string, s: SessionData) => void;
  close: (sessionId: string) => void;
  renameStart: (sessionId: string) => void;
  focusWindow: (windowId: string) => void;
  launchDevServer: (folderDir: string, cfg: LaunchConfigStatus) => void;
  focusSession: (folderDir: string, sessionId: string) => void;
};

export type PaneRect = { left: number; top: number; width: number; height: number };

/** Per-mille, so persisted layouts stay integer and the Rust mirror keeps `Eq`. */
export const COL_TOTAL = 1000;
/** Narrowest a column can be dragged, per-mille (10%). */
const MIN_COL = 100;
const SNAP_POINTS = [200, 333, 400, 500, 600, 667, 800];
const SNAP_THRESHOLD = 25;

export function colCount(n: number): number {
  return n <= 3 ? n : 2;
}

/** `null` when the pane count changed since the drag — falls back to equal. */
function validCols(n: number, cols: number[] | undefined): number[] | null {
  const k = colCount(n);
  if (!cols || cols.length !== k) return null;
  if (cols.some((c) => !Number.isInteger(c) || c < MIN_COL)) return null;
  return cols.reduce((a, b) => a + b, 0) === COL_TOTAL ? cols : null;
}

/** Equal per-mille split, remainder on the last column (k=3 → 333/333/334). */
function equalCols(k: number): number[] {
  const base = Math.floor(COL_TOTAL / k);
  return Array.from({ length: k }, (_, i) => (i === k - 1 ? COL_TOTAL - base * (k - 1) : base));
}

/** Column widths in percent for an `n`-pane tiling under `cols`. */
function colWidths(n: number, cols: number[] | undefined): number[] {
  const valid = validCols(n, cols);
  // Multiply first: `(c * 100) / 1000` divides integers, so 200‰ → exactly 20.
  if (valid) return valid.map((c) => (c * 100) / COL_TOTAL);
  const k = colCount(n);
  return Array.from({ length: k }, () => 100 / k);
}

export function paneRects(n: number, cols?: number[]): PaneRect[] {
  if (n <= 0) return [];
  const widths = colWidths(n, cols);
  if (n <= 3) {
    let left = 0;
    return widths.map((width) => {
      const r = { left, top: 0, width, height: 100 };
      left += width;
      return r;
    });
  }
  const rows = Math.ceil(n / 2);
  const h = 100 / rows;
  return Array.from({ length: n }, (_, i) => {
    const lastRowSolo = n % 2 === 1 && i === n - 1;
    return {
      left: lastRowSolo || i % 2 === 0 ? 0 : widths[0],
      top: Math.floor(i / 2) * h,
      width: lastRowSolo ? 100 : widths[i % 2],
      height: h,
    };
  });
}

/** Magnetic snap: pull a divider position (per-mille) onto the nearest
 * third/fifth/half when within `SNAP_THRESHOLD`, else keep it (integered). */
export function snapCol(pos: number): number {
  for (const p of SNAP_POINTS) {
    if (Math.abs(pos - p) <= SNAP_THRESHOLD) return p;
  }
  return Math.round(pos);
}

/** Divider `i` sits between columns `i` and `i+1`; `pos` is from the left edge. */
export function dragCol(n: number, cols: number[] | undefined, i: number, pos: number): number[] {
  const widths = [...(validCols(n, cols) ?? equalCols(colCount(n)))];
  if (i < 0 || i >= widths.length - 1) return widths;
  const leftEdge = widths.slice(0, i).reduce((a, b) => a + b, 0);
  const lo = leftEdge + MIN_COL;
  const hi = leftEdge + widths[i] + widths[i + 1] - MIN_COL;
  const target = Math.min(hi, Math.max(lo, snapCol(pos)));
  const pair = widths[i] + widths[i + 1];
  widths[i] = target - leftEdge;
  widths[i + 1] = pair - widths[i];
  return widths;
}

/** Optimistic status, until the watcher's ground truth catches up. */
export type Overlay = { status: AgentStatus; until: number };

export type Selected = { folderDir: string; sessionId: string } | null;

/** Windows are created lazily per folder, so there is no "at least one" floor
 * to restore — a stale `activeWindows` entry is simply dropped. */
export function normalizeWins(w: WindowsPayload): WindowsPayload {
  const activeWindows: Record<string, string> = {};
  for (const [folderDir, windowId] of Object.entries(w.activeWindows)) {
    if (w.windows.some((win) => win.id === windowId && win.folderDir === folderDir)) {
      activeWindows[folderDir] = windowId;
    }
  }
  return { windows: w.windows, activeWindows };
}

export type RepoCandidate = { name: string; dir: string; active: boolean };

export type RemoveTarget = {
  label: string;
  dirs: string[];
  sessionIds: string[];
  /** Not on disk, so the dialog asks about closing the task instead. */
  dirMissing?: boolean;
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
