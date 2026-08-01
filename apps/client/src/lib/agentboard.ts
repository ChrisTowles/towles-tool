import { Result } from "better-result";
import type { z } from "zod";
import type { PrItem, TaskIssueLink, TaskItem, TaskOutcome } from "./data";
import { ImageTooLarge, type IpcError } from "./errors";
import type { LaunchConfigStatus } from "./launch";
import type { RepoMeta } from "./repo-identity";
import { TaskBlockerSchema } from "./schemas/task";
import type { RailFilter } from "./settings";
import { invoke } from "./tauri";

/** Client-side view of the agentboard bridge (`crates-tauri/tt-app/src/agentboard.rs`). */

/** Outcome of `abSyncRepo` (mirrors the Rust `RepoSyncResult`). `started` is `false` only when a
 * sync for this dir was already in flight — a deduped no-op the caller should ignore quietly. */
export type RepoSyncResult = {
  started: boolean;
  ok: boolean;
  count: number;
  message?: string | null;
};

/** Force the repo checked out at `dir` to sync its issues + PRs from GitHub right now, bypassing
 * the collector poll cadence — the rail's "Sync now" action, for pulling in updates the poll
 * hasn't picked up yet. */
export const abSyncRepo = (dir: string) => invoke<RepoSyncResult>("store_sync_repo", { dir });

export const abSetSessionPurpose = (id: string, text: string | null) =>
  invoke("ab_set_session_purpose", { id, text });

export type AgentStatus = "idle" | "busy" | "complete" | "error" | "waiting" | "interrupted";

/** Per-agent live details from the transcript tail (tokens, cache, model).
 * Mirrors the Rust `AgentEventDetails`; only the fields the UI renders. */
export type AgentEventDetails = {
  model?: string | null;
  contextUsed?: number | null;
  contextMax?: number | null;
  cacheExpiresAt?: number | null;
  cacheTtlMs?: number | null;
  lastActivityAt?: number | null;
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

/** One port a session's shell saw in its folder's `.env` at spawn time that the file now claims
 * differently — e.g. */
export type PortDrift = { key: string; spawnedPort: number; currentPort: number };

/** One PTY shell inside a folder. "Agent" is a badge: `agentState` is set when
 * Claude (or another agent) is detected running in this PTY. */
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
  /** Echo of the prompt Claude was launched with, auto-captured at launch so the rail's hover
   * tooltip can explain why this session exists. */
  purpose?: string | null;
  portDrift?: PortDrift[];
};

export type LandedVia = "merged" | "rebase-merged" | "squash-merged" | "upstream gone";

export type RowTask = {
  id: number;
  status: string;
  branch?: string;
};

/** Why a rail row exists — the record behind it, never a fact about the filesystem
 * (`tt_agentboard::types::RowRecord`). A row is on screen because something wrote it down. */
export type RowRecord =
  /** A `repos.json` entry — a checkout the user tracks. The one row kind with
   * no task: tracking a repo isn't a unit of work. */
  | { origin: "checkout" }
  /** The user's own work. */
  | { origin: "task"; task: RowTask }
  /** A git worktree found on disk that no task claimed — Claude Code's own agent worktrees, or a
   * hand-added one. */
  | { origin: "detected"; task: RowTask };

/** The worktree operation running on a row right now (`tt_agentboard::types::RowPhase`), stamped
 * by the app — the only thing that can tell a create in progress from one that died an hour
 * ago. */
export type RowPhase = { state: "creating"; label: string } | { state: "removing"; label: string };

/** The board row behind a folder, if it has one. */
export function folderTask(folder: FolderData): RowTask | undefined {
  return folder.record.origin === "checkout" ? undefined : folder.record.task;
}

export function folderIsUnclaimed(folder: FolderData): boolean {
  return folder.record.origin === "detected";
}

/** `git worktree add` is running for this row right now. */
export function folderCreating(folder: FolderData): boolean {
  return folder.phase?.state === "creating";
}

/** The removal sequence is running for this row right now. */
export function folderRemoving(folder: FolderData): boolean {
  return folder.phase?.state === "removing";
}

/** The task's worktree isn't on disk and nothing is working on it — a failed create, a directory
 * deleted outside the app, or a restart mid-removal. */
export function folderDetached(folder: FolderData): boolean {
  return folder.record.origin !== "checkout" && folder.dirMissing && !folderBusy(folder);
}

/** The branch a detached task's worktree would be rebuilt on — the task's own
 * record first, since a row with no directory has no git to read one from.
 * `undefined` means nothing to rebuild — an unclaimed (`detected`) row was
 * never the user's to recreate. */
export function folderRecreateBranch(
  folder: Pick<FolderData, "record" | "branch">,
): string | undefined {
  if (folder.record.origin !== "task") return undefined;
  return folder.record.task.branch?.trim() || folder.branch.trim() || undefined;
}

/** An operation is running on this row, so it can't be worked in or acted on.
 * Covers both directions — a row being created and one being removed. */
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
  /** What the working tree holds that `HEAD` doesn't — staged, unstaged and untracked. Untracked
   * files count as files but carry no line counts. Never add this to `committed*`. */
  uncommittedFiles: number;
  uncommittedAdded: number;
  uncommittedRemoved: number;
  /** `uncommittedFiles` is a floor: an untracked directory was too large to list file by file
   * (almost always a `.gitignore` gap). The chip shows a `+`, the diff pane names the directory. */
  uncommittedCapped: boolean;
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
  /** Epoch ms this checkout was last worked in, as Rust can see it: the newest of `HEAD`'s
   * commit time, the newest mtime among the working tree's changed paths (the only signal that
   * sees an editor-only session) and the last pane opened or closed here. */
  workedAtMs?: number;
  /** Newest mtime among the working tree's changed paths, epoch ms (0 when clean). Unlike
   * `workedAtMs`, opening a pane doesn't move it — a pure "the files under review changed"
   * signal. See `folderStatsKey`. */
  worktreeTouchedMs?: number;
  hasPortDrift: boolean;
  /** True when this checkout has a Claude Desktop `.claude/launch.json` — gates the rail's dev-
   * servers button and picks the pane-header button's dimmed/how-to state (`components/dev-
   * servers.tsx`); the configs themselves are fetched on demand via `launch_configs`. */
  hasLaunchConfig: boolean;
  quiet: boolean;
};

/** The one definition of "this folder's working tree measurably changed" — the diff and
 * files panes refetch on it.
 *
 * Six aggregate counts can't tell every change from every other: a line traded between two
 * files, or an equal-length rewrite, lands on identical totals and used to leave both panes
 * showing the previous content until something unrelated moved. `worktreeTouchedMs` closes
 * that — content moving is enough on its own. */
export function folderStatsKey(folder: FolderData): string {
  return [
    folder.committedFiles,
    folder.committedAdded,
    folder.committedRemoved,
    folder.uncommittedFiles,
    folder.uncommittedAdded,
    folder.uncommittedRemoved,
    folder.commitsAhead,
    folder.worktreeTouchedMs ?? 0,
  ].join(":");
}

/** The other half: "what this folder's diff is measured *against* moved". A rebase or a
 * fetch changes the merge-base while every working-tree stat above stays put, so a pane
 * that refetches on `folderStatsKey` alone goes on listing files from the old baseline.
 * Both keys drive `DiffPane`'s refetch; `MonacoMultiDiff` takes this one for its base sides. */
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

/** One commit ahead of `comparedBase`, with its own line-count diff — not the folder's
 * cumulative `linesAdded`/`linesRemoved`. */
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

/** A logical repo: a checkout plus every other rail folder that's a `git worktree` sibling of it
 * (same git common dir), whether that sibling is explicitly tracked or only discovered via `git
 * worktree list` (see `RepoData` in `crates/tt-agentboard/src/types.rs`). */
export type RepoData = {
  key: string;
  /** Absolute dir of the checkout this row is anchored to — the dir also embedded in `key`, as a
   * field so readers never parse it back out. */
  dir: string;
  name: string;
  originUrl?: string | null;
  folders: FolderData[];
  needs: number;
  /** User-chosen icon/color for this repo (Settings → Agentboard). Absent — or absent fields —
   * means "render exactly as an unthemed repo": never synthesize a color from the name. */
  meta?: RepoMeta;
};

export type Panes = [string, ...string[]];

function toPanes(ids: string[]): Panes | null {
  return ids.length > 0 ? (ids as Panes) : null;
}

/** One in-app window: a named tiling of pane session-ids. Scoped to a single folder — a window
 * may never hold panes from more than one checkout. */
export type AgWindow = {
  id: string;
  name: string;
  folderDir: string;
  panes: Panes;
  cols?: number[];
};

export type WindowsPayload = { windows: AgWindow[]; activeWindows: Record<string, string> };

/** `AgWindow` as persisted / sent over the wire, before parsing: `panes` may
 * be empty in blobs written before empty windows became unrepresentable. */
export type WireWindow = Omit<AgWindow, "panes"> & { panes: string[] };
export type WireWindowsPayload = { windows: WireWindow[]; activeWindows: Record<string, string> };

export type StatePayload = {
  repos: RepoData[];
  compactRecommendPercent: number;
  windows: WireWindowsPayload;
  collapsed: Record<string, boolean>;
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

// Folder panes (diff, files) A window's `panes` normally hold session ids (`s<16 hex>` from the
// backend's `gen_id`).

const DIFF_PANE_PREFIX = "~diff:";
const FILES_PANE_PREFIX = "~files:";
const PREVIEW_PANE_PREFIX = "~preview:";
const JARVIS_PANE_PREFIX = "~jarvis:";
const EXIT_PANE_PREFIX = "~exit:";

/** The (per-folder) pane id of the folder's diff pane. */
export function diffPaneId(folderDir: string): string {
  return `${DIFF_PANE_PREFIX}${folderDir}`;
}

export function isDiffPane(paneId: string): boolean {
  return paneId.startsWith(DIFF_PANE_PREFIX);
}

/** The folder dir a diff pane id points at (null otherwise). */
export function diffPaneDir(paneId: string): string | null {
  return isDiffPane(paneId) ? paneId.slice(DIFF_PANE_PREFIX.length) : null;
}

/** The (per-folder) pane id of the folder's files pane. */
export function filesPaneId(folderDir: string): string {
  return `${FILES_PANE_PREFIX}${folderDir}`;
}

export function isFilesPane(paneId: string): boolean {
  return paneId.startsWith(FILES_PANE_PREFIX);
}

/** The folder dir a files pane id points at (null otherwise). */
export function filesPaneDir(paneId: string): string | null {
  return isFilesPane(paneId) ? paneId.slice(FILES_PANE_PREFIX.length) : null;
}

/** Resolve a terminal file-link path to a files-pane path relative to the folder checkout, or
 * null when the file lives outside it (the files pane can only browse the checkout — outside
 * paths stay external-editor territory). */
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

/** The folder dir a preview pane id points at (null otherwise). */
export function previewPaneDir(paneId: string): string | null {
  return isPreviewPane(paneId) ? paneId.slice(PREVIEW_PANE_PREFIX.length) : null;
}

/** The (per-folder) pane id of the folder's native pane — a rectangle of the window handed to
 * `tt-jarvis`'s Bevy renderer as a real compositor surface (`components/native-pane.tsx`),
 * tiled beside the folder's terminals rather than pinned under the rail. */
export function jarvisPaneId(folderDir: string): string {
  return `${JARVIS_PANE_PREFIX}${folderDir}`;
}

export function isJarvisPane(paneId: string): boolean {
  return paneId.startsWith(JARVIS_PANE_PREFIX);
}

/** The folder dir a native pane id points at (null otherwise). */
export function jarvisPaneDir(paneId: string): string | null {
  return isJarvisPane(paneId) ? paneId.slice(JARVIS_PANE_PREFIX.length) : null;
}

export function folderPaneDir(paneId: string): string | null {
  return (
    diffPaneDir(paneId) ?? filesPaneDir(paneId) ?? previewPaneDir(paneId) ?? jarvisPaneDir(paneId)
  );
}

/** The pane id of a crashed session's tombstone. */
export function exitPaneId(sessionId: string): string {
  return `${EXIT_PANE_PREFIX}${sessionId}`;
}

export function isExitPane(paneId: string): boolean {
  return paneId.startsWith(EXIT_PANE_PREFIX);
}

/** The session a tombstone reports on (null for any other pane). */
export function exitPaneSession(paneId: string): string | null {
  return isExitPane(paneId) ? paneId.slice(EXIT_PANE_PREFIX.length) : null;
}

/** The session a pane belongs to, live or dead — a session pane is its own id, a tombstone
 * unwraps to the session it reports on, folder panes have none. */
export function paneSession(paneId: string): string | null {
  if (folderPaneDir(paneId) !== null) return null;
  return exitPaneSession(paneId) ?? paneId;
}

// Pure window-layout reducers (unit-tested; the screen wraps them in
// `updateWins` for persistence)

/** Last id handed out, so a same-millisecond mint can't repeat one. */
let lastWindowSeq = 0;

/** Mint a window id. */
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

/** Last id handed out, so a same-millisecond mint can't repeat one. */
let lastDraftScopeSeq = 0;

/** Mint a scope id for a new-task form's image staging directory. Same reasoning as {@link
 * nextWindowId}: two forms opened in the same millisecond (e.g. */
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
    // Stale/missing active entry: reuse the folder's first existing window before minting a new
    // one — otherwise a dangling entry spawns a duplicate "primary" beside the window the user
    // already has.
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

/** Append while keeping the non-empty tuple type (a plain spread widens to
 * `string[]`). */
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

/** The folder dirs whose slice of the layout (their windows, in order, or their active-window
 * entry) differs between two payloads — exactly the `touchedFolders` the backend's merge-by-
 * folder save needs. */
export function changedFolderDirs(a: WireWindowsPayload, b: WireWindowsPayload): string[] {
  const dirs = new Set<string>([
    ...a.windows.map((win) => win.folderDir),
    ...b.windows.map((win) => win.folderDir),
    ...Object.keys(a.activeWindows),
    ...Object.keys(b.activeWindows),
  ]);
  return [...dirs].filter((d) => folderSignature(a, d) !== folderSignature(b, d));
}

/** One folder's slice of a layout, as a comparable string. */
function folderSignature(p: WireWindowsPayload, dir: string): string {
  return JSON.stringify([
    p.windows.filter((win) => win.folderDir === dir),
    p.activeWindows[dir] ?? null,
  ]);
}

/** Parse a persisted layout into the live shape. */
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
        // A tombstone lives and dies with the session it reports on: once the record is gone
        // there's nothing left to name, so it prunes like the session pane it replaced.
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

/** A session is an "agent" session iff Claude is running in it right now. */
export function isAgent(s: SessionData): boolean {
  return s.agentState != null;
}

/** A session "needs you" only when a shell actually exists for it (live PTY — anything else is a
 * stale record whose agent status can't be current) AND its agent demands attention: blocked on
 * input, errored, or its turn just ended and you haven't looked yet (`unseen` terminal state,
 * cleared by `ab_mark_seen` on select). */
export function sessionNeeds(s: SessionData): boolean {
  if (!s.live) return false;
  const st = s.agentState?.status;
  if (st === "waiting" || st === "error") return true;
  return s.unseen && (st === "complete" || st === "interrupted");
}

/** A session should catch your eye when it needs you right now (`sessionNeeds`) or when its
 * agent reached a terminal state (done/errored/interrupted) you haven't acknowledged yet
 * (`unseen`, cleared by `ab_mark_seen` on select). */
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

export function cycleNeedsYou(
  repos: RepoData[],
  fromSessionId: string | null,
  direction: "next" | "prev",
): SessionData | null {
  const all: SessionData[] = [];
  for (const r of repos) for (const f of r.folders) for (const s of f.sessions) all.push(s);

  const targetIndexes = all.map((s, i) => (sessionCatchesEye(s) ? i : -1)).filter((i) => i !== -1);
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

/** A folder's currently-running (PTY-live) sessions. */
export function liveSessions(folder: FolderData): SessionData[] {
  return folder.sessions.filter((s) => s.live);
}

/** Every distinct port-drift entry across a folder's live sessions, deduped by key +
 * spawned/current pair (several panes spawned at different times can carry the same drift, or
 * genuinely different ones if a port rotated more than once) — the detail list for the folder-
 * header badge's tooltip. */
export function folderPortDrift(folder: Pick<FolderData, "sessions">): PortDrift[] {
  const seen = new Map<string, PortDrift>();
  for (const s of folder.sessions) {
    for (const d of s.portDrift ?? []) {
      seen.set(`${d.key}:${d.spawnedPort}:${d.currentPort}`, d);
    }
  }
  return [...seen.values()];
}

/** The label a session row leads with: when an agent is running, its task/thread name (so the
 * row reads as *the agent*, not a bare "shell 1"); otherwise the shell's own name. */
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

/** The collapse-map key(s) plain Left/Right arrow navigation acts on for a given repo + its
 * focused folder — the same keying the rail's click-to-toggle chevrons already use
 * (`agentboard-repo-group.tsx`): a solo-checkout repo collapses at the repo header (`repo.key`,
 * one level, no parent); a multi-checkout repo collapses per-folder (``
 * `${repo.key}::${folder.dir}` ``) nested under the repo header (`repo.key`) as a distinct
 * outer level. */
export function collapseTargetKeys(
  repo: Pick<RepoData, "key" | "folders">,
  folderDir: string,
): { own: string; parent: string | null } {
  if (isSoloRepo(repo as RepoData)) return { own: repo.key, parent: null };
  return { own: `${repo.key}::${folderDir}`, parent: repo.key };
}

/** How long after its last sign of agent life a folder still counts as active for the rail
 * filter, so stopping a session doesn't make its folder vanish from the rail the same instant. */
export const QUIET_GRACE_MS = 45 * 60_000;

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

/** A folder (checkout) is "quiet" when nothing about it needs attention right now: no live
 * session, no session that catches the eye (waiting/errored/ unseen), no unpushed local commits
 * or dirty working tree, and no agent activity within the `QUIET_GRACE_MS` grace window (so a
 * folder eases off the rail a while after work stops, rather than the moment it does). */
export function isFolderQuiet(f: FolderData, now: number): boolean {
  return (
    f.quiet ||
    (liveSessions(f).length === 0 &&
      f.uncommittedFiles === 0 &&
      f.commitsAhead === 0 &&
      f.sessions.every((s) => !sessionCatchesEye(s)) &&
      now - folderLastActivityAt(f) >= QUIET_GRACE_MS)
  );
}

/** The newest sign that *someone worked in this checkout* — the backend's {@link
 * FolderData.workedAtMs} stamps, plus the agent activity only the client sees. */
export function folderLastWorkedAt(f: FolderData): number {
  return Math.max(folderLastActivityAt(f), f.workedAtMs ?? 0);
}

/** Whether a folder falls outside the "worked in the last `hours` hours" window. */
export function isFolderStale(f: FolderData, now: number, hours: number): boolean {
  if (f.quiet) return true;
  if (liveSessions(f).length > 0) return false;
  return now - folderLastWorkedAt(f) >= hours * 3_600_000;
}

/** The rail's one filter predicate: whether `filter` demotes this folder to the per-repo "N
 * quiet" stub row. */
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
      return isFolderQuiet(f, now);
    case "recent":
      return isFolderStale(f, now, recentHours);
  }
}

export function pathScope(dir: string): string | null {
  const m = dir.match(/\/code\/([a-z])\//);
  return m ? `${m[1]}/` : null;
}

/** The open PR for a folder's branch: exact branch match, scoped to the repo via its origin URL
 * (PR rows carry gh's `owner/name`, which both https and ssh remote URLs contain). */
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

/** The board task bound to a folder's worktree, matched on `worktree.dir` — the one link from a
 * rail folder back to its #339 task. */
export function taskForFolder(tasks: TaskItem[], dir: string): TaskItem | undefined {
  return tasks.find((t) => t.worktree?.dir === dir);
}

export function issuesForFolder(tasks: TaskItem[], dir: string): TaskIssueLink[] {
  return taskForFolder(tasks, dir)?.issues ?? [];
}

/** "Would removing this lose anything" — a pure git fact, and only *half* the badge gate (see
 * {@link folderSafeToDelete}). */
export function folderHoldsNoWork(folder: Pick<FolderData, "dirty" | "commitsUnlanded">): boolean {
  return !folder.dirty && folder.commitsUnlanded === 0;
}

/** Whether this checkout may be shown as **safe to delete**: its PR merged, *and* nothing here
 * would be lost. */
export function folderSafeToDelete(
  folder: Pick<FolderData, "dirty" | "commitsUnlanded">,
  pr: Pick<PrItem, "state"> | undefined,
): boolean {
  return pr?.state === "merged" && folderHoldsNoWork(folder);
}

/** True when this branch's work reached the base branch — proven either by git itself
 * (`folder.landed`, which sees merge commits, rebases and squash merges alike) or by a merged
 * GitHub PR. */
export function folderLanded(
  folder: Pick<FolderData, "landed">,
  pr: Pick<PrItem, "state"> | undefined,
): boolean {
  return folder.landed !== null || pr?.state === "merged";
}

/** Whether the delete-worktree affordances (rail menu, the `ab-remove-task` chord) apply to a
 * folder. */
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

/** True when a branch having landed doesn't actually make its checkout safe to delete: the work
 * reached the base (`folderLanded` — a merged PR, or git's own proof), but the checkout still
 * has uncommitted changes or commits that haven't landed yet (`!folderHoldsNoWork`). */
export function folderLandedButHasWork(
  folder: Pick<FolderData, "dirty" | "commitsUnlanded" | "landed">,
  pr: Pick<PrItem, "state"> | undefined,
): boolean {
  return folderLanded(folder, pr) && !folderHoldsNoWork(folder);
}

/** A per-folder actionable signal: the checkout is safe to clean up, has sessions waiting on
 * you, or its live panes have drifted ports. */
export type ActionableKind = "safe-to-delete" | "needs-you" | "port-drift";

export type ActionableItem = {
  kind: ActionableKind;
  subtitle: string;
  pr?: Pick<PrItem, "number" | "url">;
};

/** Every actionable signal that applies to one folder — the same gates the rail's badges use
 * (`folderSafeToDelete`, `folder.needs > 0`, `folderPortDrift`). */
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
  // Promote on the *rounded* value, not the raw one: 999_500 rounds to 1000K,
  // which has to read as 1M.
  if (k < 1_000) return `${k}K`;
  const m = Math.round(n / 100_000) / 10;
  // 1M, not 1.0M — but keep 1.5M's fraction. Tested after rounding, so 1_020_000
  // reads as 1M rather than 1.0M.
  return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
}

/** Diff magnitudes for a rail chip: `847`, `12.3K`, `1.2M`. */
export function fmtDiffLines(n: number): string {
  if (n < 10_000) return `${n}`;
  const k = n / 1_000;
  if (k < 100) return `${Math.round(k * 10) / 10}K`;
  // Promote on the *rounded* value, like `fmtTokens`: 999,500 rounds to
  // 1000K, which has to read as 1M.
  const rounded = Math.round(k);
  if (rounded < 1_000) return `${rounded}K`;
  const m = Math.round(n / 100_000) / 10;
  return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
}

/** `412K / 1M` — what a session is holding against what it can hold. Null when the window size
 * is unknown, since a bare used-count answers nothing. */
export function fmtContext(d: AgentEventDetails | null | undefined): string | null {
  if (!d?.contextMax) return null;
  if (!d.contextUsed) return `${fmtTokens(d.contextMax)} window`;
  return `${fmtTokens(d.contextUsed)} / ${fmtTokens(d.contextMax)}`;
}

/** `claude-opus-4-8 · 412K / 1M` — what a cold resume would cost, in one line: which model, and
 * how much context it would re-send. */
export function modelContextLabel(d: AgentEventDetails | null | undefined): string | null {
  const parts = [d?.model, fmtContext(d)].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** True when a folder's branch label would only restate the folder's own name: a worktree task's
 * directory *is* the slug of its branch (`feat/model-indicator-badge` → `feat-model-indicator-
 * badge`), so printing both spends a rail line saying one thing twice. */
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

/** The conventional-commit prefixes `tt task new`/the create-branch flow use (see the root
 * CLAUDE.md's branch-naming convention) — stripped off before humanizing so a worktree folder
 * with no bound task title still reads as a sentence, not "Feat today we use…". */
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

/** Render-time-only fallback for a worktree folder with no bound task (or whose task has no
 * title): turn the slugged folder name back into a plain-words guess — strip a conventional
 * prefix segment, dashes to spaces, sentence-case. */
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

/** How far before expiry the cache counts as "expiring": 2m on the 5-minute cache, 10m on the
 * 1-hour cache — enough headroom to nudge the session (any request re-warms the cache) before a
 * resume goes full-price. */
export function cacheWarnMs(ttlMs: number | null | undefined): number {
  return ttlMs === 3_600_000 ? 600_000 : 120_000;
}

/** Still warm, but inside the warn window — one nudge away from going cold. */
export function isCacheExpiring(d: AgentEventDetails | null | undefined, now: number): boolean {
  if (!d?.cacheExpiresAt || isCold(d, now)) return false;
  return d.cacheExpiresAt - now <= cacheWarnMs(d.cacheTtlMs);
}

/** The compact nudge: cold AND at/above the settings threshold. Warm-and-huge
 * is fine to keep going — the cost only bites on a cold resume. */
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

/** The one dot color for a whole rollup — same busy/waiting/error precedence as a collapsed rail
 * row, so a collapsed nav icon's badge never disagrees with the rail's own collapsed dots. */
export function rollupAlertColor(r: AgentRollup): string | null {
  if (r.error > 0) return "bg-red-500";
  if (r.waiting > 0) return "bg-blue-500";
  if (r.busy > 0) return "bg-cyan-500";
  if (r.total > 0) return "bg-emerald-500";
  return null;
}

/** Badge text color to pair with `rollupAlertColor`'s background — white reads fine on the
 * red/blue/emerald fills, but on cyan-500 (busy) it's nearly illegible, so that one badge needs
 * dark text instead. */
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

/** Ambient status color for a set of sessions hidden behind a collapse: red if one errored, blue
 * if one is waiting on you, cyan while an agent is busy, else a calm emerald for "live but
 * idle". */
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

/** Write, retrying while the PTY spawns (a just-mounted terminal takes a beat before
 * `term_start` registers it). */
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

/** Wait for `termId`'s first `terminal://frame` (the shell's first output — a real proxy for
 * "the PTY is actually reading input", unlike a successful `term_write`, which only proves the
 * Rust-side write conduit exists and can still race the shell sourcing its rc files and eating
 * a queued command). */
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

/** Single-quote a string for safe injection into a shell command line typed
 * into a PTY (POSIX `'...'` escaping — embedded `'` becomes `'\''`). */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export type ClaudeModel = "sonnet" | "opus" | "fable";

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type ClaudeLaunchOptions = {
  model?: ClaudeModel;
  effort?: ClaudeEffort;
};

/** The `claude` invocation for a session's PTY: bare, or with an initial prompt passed as an
 * argument so Claude starts working on it immediately instead of waiting at an empty prompt,
 * plus an optional `--model`/`--effort` pair for callers (e.g. */
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
    // Clipboard images arrive as `image.png` every time, so the index keeps
    // React keys distinct across several pastes in one form.
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

/** The `claude` invocation to resume a past session (from the Claude Sessions
 * history) in place, typed into the folder's PTY. */
export function claudeResumeCommand(sessionId: string): string {
  return `claude --resume ${shellQuote(sessionId)}\r`;
}

/** A cross-screen handoff: "select this folder/session in Agentboard, then type a resume command
 * into it." Agentboard may not be mounted yet when the request is made (e.g. */
export type PendingOpenSession = {
  folderDir: string;
  sessionId: string;
  resumeId: string;
  label: string;
};

/** A queue, not a single task: the resume picker hands off every ticked pane at once, at boot,
 * when Agentboard is typically not mounted yet — so all of them stash and keeping only the last
 * would resume one session out of N. */
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

/** One pane the app was running Claude in when it last closed — crash or ordinary quit. Mirrors
 * the Rust `ResumeCandidate` payload (`tt_agentboard::resume`). */
export type ResumeCandidate = {
  folderDir: string;
  paneId: string;
  paneName: string;
  claudeSessionId: string;
  title: string | null;
  lastActiveMs: number;
};

/** Panes to offer resuming from the previous run, however it ended — crash, kill, or an ordinary
 * quit. Empty when there's no prior run to offer (e.g. */
export const resumeCandidates = () => invoke<ResumeCandidate[]>("ab_resume_candidates");

/** A read-only "reveal this folder/session in Agentboard" handoff — the command palette's jump-
 * to-repo/session entries. */
export type AgentboardNav =
  | { kind: "folder"; folderDir: string }
  | { kind: "session"; folderDir: string; sessionId: string }
  /** Reopen a closed task: open its repo's inline new-task form, pre-filled with the task's text
   * as the goal and bound to its existing id (see the Board screen's "Reopen" action) —
   * submitting mints a fresh worktree for the same task instead of a new card, mirroring "start
   * a task". */
  | {
      kind: "reopen-task";
      repoDir: string;
      repoName: string;
      repoKey: string;
      originUrl?: string;
      taskId: number;
      goal: string;
    }
  /** Start a task with no human at the form: mint its worktree on `branch` and launch an agent
   * on `goal`, immediately. */
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
  /** Put a file the agent points at on screen in a folder's Preview pane: the MCP `preview_file`
   * tool's delivery (see `lib/preview-artifact.ts`). */
  | {
      kind: "show-file";
      folderDir: string | null;
      path: string;
      title: string;
      nonce: number;
    }
  /** Reveal a path already on disk in a folder's Files pane: the MCP `file_open`
   * tool and `tt open`'s delivery (`lib/editor-open.ts`). `path` is absolute —
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

/** The lifecycle actions a session row can trigger. All are PTY writes — the
 * agent is whatever runs in the real shell, never a re-rendered proxy. */
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

/** Column widths (`AgWindow.cols`) are stored in per-mille of the tiling width
 * so persisted layouts stay integer (the Rust mirror keeps `Eq`). */
export const COL_TOTAL = 1000;
/** Narrowest a column can be dragged, per-mille (10%). */
const MIN_COL = 100;
const SNAP_POINTS = [200, 333, 400, 500, 600, 667, 800];
const SNAP_THRESHOLD = 25;

export function colCount(n: number): number {
  return n <= 3 ? n : 2;
}

/** `cols` when it matches the current layout (right length, sane values), else
 * `null` — a pane count changed since the drag falls back to equal columns. */
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

/** Column widths after dragging divider `i` (the boundary between columns `i` and `i+1`) to
 * `pos` per-mille from the tiling's left edge. */
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

/** Optimistic status shown for ~2.5s after a lifecycle action, until the
 * watcher's ground truth catches up on its next scan. */
export type Overlay = { status: AgentStatus; until: number };

export type Selected = { folderDir: string; sessionId: string } | null;

/** Drop any `activeWindows` entries pointing at a window that no longer exists (or whose folder
 * no longer matches) — windows are created lazily per folder as sessions open, so there's no
 * "at least one window" floor. */
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
  /** The worktree isn't on disk — the dialog then asks about closing the task,
   * not about deleting a checkout that would be a lie to describe. */
  dirMissing?: boolean;
};

export type BlockedDelete = {
  target: RemoveTarget;
  name: string;
  outcome?: TaskOutcome;
  blockers: TaskBlocker[];
  /** Caveats about how the verdict was reached (a failed fetch → stale refs),
   * carried through so the dialog can qualify the blockers it lists. */
  messages: string[];
};

/** A session about to get Claude launched in it, awaiting the "what are you working toward?"
 * prompt (see `commitStartClaude`). */
export type StartClaudeTarget = {
  folderDir: string;
  sessionId: string;
  sessionName: string;
  restart: boolean;
};
