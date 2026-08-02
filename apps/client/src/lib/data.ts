import { useEffect, useState } from "react";
import type { Result } from "better-result";
import type { IpcError } from "./errors";
import { invoke, isTauri } from "./tauri";
import { type TaskDeleteOutcome, TaskDeleteOutcomeSchema } from "./schemas/task";

/** Client-side view of the store (Rust `tt-store`): the camelCase snapshot from
 * `store_snapshot` / the `store://snapshot` event. Timestamps are epoch ms
 * except calendar `start`/`end` (RFC 3339, calendar's offset). */

export type WireCalEvent = {
  id: number;
  source: string;
  externalId: string;
  title: string;
  start: string;
  end?: string;
  attendees: string[];
  location?: string;
  joinUrl?: string;
};

/** The wire shape plus epoch-ms `startTs`/`endTs`. Both on purpose:
 * arithmetic wants the number; only the string records "3pm *there*". */
export type CalEvent = {
  id: number;
  source: string;
  externalId: string;
  title: string;
  start: string;
  end?: string;
  startTs: number;
  endTs?: number;
  attendees: string[];
  location?: string;
  joinUrl?: string;
};

/** An unparseable `start` (NaN poisons countdowns) drops the row. */
function toCalEvent(e: WireCalEvent): CalEvent | null {
  const startTs = Date.parse(e.start);
  if (Number.isNaN(startTs)) return null;
  const endMs = e.end === undefined ? undefined : Date.parse(e.end);
  return {
    ...e,
    startTs,
    endTs: endMs !== undefined && !Number.isNaN(endMs) ? endMs : undefined,
  };
}

export function toCalEvents(events: WireCalEvent[]): CalEvent[] {
  return events.map(toCalEvent).filter((e): e is CalEvent => e !== null);
}

/** Kanban columns in board order: untouched, actively worked, done. */
export const TASK_STATUSES = ["backlog", "doing", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** The terminal column reads "Closed" because it also holds `abandoned` tasks. */
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "Backlog",
  doing: "In progress",
  done: "Closed",
};

/** How a closed task ended — `outcome` on `TaskItem`, absent while open. */
const TASK_OUTCOMES = ["done", "abandoned"] as const;
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];

export type TaskIssueLink = {
  repo: string;
  number: number;
  url: string;
  state: "open" | "closed" | (string & {});
};

export type TaskPrLink = {
  repo: string;
  number: number;
  url: string;
  state: "open" | "merged" | "closed" | (string & {});
  checks: string;
};

/** A closed task keeps all but `dir` as historical fact. */
export type TaskWorktree = {
  repoRoot: string;
  repo?: string;
  branch?: string;
  dir?: string;
};

/** A task — the unit of work (#339): 0..N issues, 0..N PRs, usually a worktree. */
export type TaskItem = {
  id: number;
  text: string;
  status: TaskStatus;
  position: number;
  createdAt: number;
  completedAt?: number;
  outcome?: TaskOutcome;
  archivedAt?: number;
  notes?: string;
  goal?: string;
  /** The agent's wrap-up (MCP `task_summary`) — would die with the scrollback. */
  summary?: string;
  summaryAt?: number;
  worktree?: TaskWorktree;
  issues: TaskIssueLink[];
  prs: TaskPrLink[];
  /** Closed = carries an outcome or sits in `done`. Computed backend-side so
   * every consumer agrees; renders in "Closed" whatever the frozen status. */
  closed: boolean;
  /** The badge a closed card shows: `outcome`, or `done` implied by `status`. */
  displayOutcome?: TaskOutcome;
  /** A live worktree checkout on disk right now — not a "task only" card or a
   * closed task whose worktree was torn down. */
  hasWorktree: boolean;
};

/** `dismissedTs` = the `updatedTs` at dismissal (0 = never). Hidden while
 * `dismissedTs >= updatedTs`; reappears on a newer `updatedTs`. */
export type IssueItem = {
  repo: string;
  number: number;
  title: string;
  labels: string[];
  state: string;
  url: string;
  updatedTs: number;
  dismissedTs: number;
};

export type PrItem = {
  repo: string;
  number: number;
  title: string;
  branch: string;
  state: string;
  checks: string;
  reviewState: string;
  url: string;
  updatedTs: number;
  dismissedTs: number;
};

export function isItemDismissed(item: { dismissedTs: number; updatedTs: number }): boolean {
  return item.dismissedTs > 0 && item.dismissedTs >= item.updatedTs;
}

export type CollectRun = {
  collector: string;
  ranAt: number;
  ok: boolean;
  message?: string;
};

/** Latest state of a watched Slack DM (the `slack:dm` collector). */
export type DmItem = {
  channel: string;
  fromName: string;
  text: string;
  ts: number;
  fromMe: boolean;
  url?: string;
  fetchedAt: number;
  dismissedTs: number;
};

/** The one predicate both the DM banner and the needs-you count derive from. */
export function dmsNeedingAttention(snapshot: StoreSnapshot): DmItem[] {
  return snapshot.dms.filter((d) => !d.fromMe && d.dismissedTs < d.ts);
}

/** One handled MCP request (this instance's loopback server). */
export type McpCall = {
  id: number;
  ts: number;
  method: string;
  tool?: string;
  args?: string;
  ok: boolean;
  error?: string;
  durationMs?: number;
  client?: string;
};

/** The snapshot exactly as the backend sends it — see {@link WireCalEvent}. */
export type WireStoreSnapshot = Omit<StoreSnapshot, "events"> & { events: WireCalEvent[] };

/** The one place event times are parsed out of the wire format. */
export function toStoreSnapshot(wire: WireStoreSnapshot): StoreSnapshot {
  return { ...wire, events: toCalEvents(wire.events) };
}

export type StoreSnapshot = {
  events: CalEvent[];
  tasks: TaskItem[];
  issues: IssueItem[];
  prs: PrItem[];
  runs: CollectRun[];
  dms: DmItem[];
  mcpCalls: McpCall[];
};

const MINUTE = 60_000;

export const EMPTY_SNAPSHOT: StoreSnapshot = {
  events: [],
  tasks: [],
  issues: [],
  prs: [],
  runs: [],
  dms: [],
  mcpCalls: [],
};

function at(ms: number): string {
  return new Date(ms).toISOString();
}

/** Browser-dev fallback: representative rows, authored in the wire shape and
 * parsed by the real `toCalEvents` so the conversion can't drift. */
export function mockSnapshot(now: number = Date.now()): StoreSnapshot {
  return {
    events: toCalEvents([
      {
        id: 1,
        source: "outlook",
        externalId: "mock-standup",
        title: "Team standup",
        start: at(now + 25 * MINUTE),
        end: at(now + 40 * MINUTE),
        attendees: [],
        location: "Meet",
        joinUrl: "https://meet.example.com/mock-standup",
      },
      {
        id: 2,
        source: "outlook",
        externalId: "mock-design-review",
        title: "Design review",
        start: at(now + 90 * MINUTE),
        end: at(now + 120 * MINUTE),
        attendees: [],
        location: "Meet",
      },
      {
        id: 3,
        source: "outlook",
        externalId: "mock-1on1",
        title: "1:1 with Sam",
        start: at(now + 150 * MINUTE),
        end: at(now + 180 * MINUTE),
        attendees: [],
      },
      {
        id: 4,
        source: "google",
        externalId: "mock-lunch",
        title: "Lunch & learn",
        start: at(now + 210 * MINUTE),
        end: at(now + 240 * MINUTE),
        attendees: [],
      },
      {
        id: 5,
        source: "outlook",
        externalId: "mock-planning",
        title: "Sprint planning",
        start: at(now + 270 * MINUTE),
        end: at(now + 330 * MINUTE),
        attendees: [],
      },
      {
        id: 6,
        source: "outlook",
        externalId: "mock-retro",
        title: "Retro",
        start: at(now + 360 * MINUTE),
        end: at(now + 390 * MINUTE),
        attendees: [],
      },
    ]),
    tasks: [],
    issues: [
      {
        repo: "octo/widgets",
        number: 118,
        title: "Flaky terminal resize on hidden panes",
        labels: ["bug"],
        state: "open",
        url: "https://github.com/octo/widgets/issues/118",
        updatedTs: now - 5 * 60 * MINUTE,
        dismissedTs: 0,
      },
    ],
    prs: [
      {
        repo: "octo/widgets",
        number: 42,
        title: "feat: add treemap rendering",
        branch: "feat/treemap",
        state: "open",
        checks: "passing",
        reviewState: "",
        url: "https://github.com/octo/widgets/pull/42",
        updatedTs: now - 30 * MINUTE,
        dismissedTs: 0,
      },
      {
        repo: "octo/widgets",
        number: 43,
        title: "fix: race in collector scheduler",
        branch: "fix/scheduler-race",
        state: "open",
        checks: "failing",
        reviewState: "review_requested",
        url: "https://github.com/octo/widgets/pull/43",
        updatedTs: now - 2 * 60 * MINUTE,
        dismissedTs: 0,
      },
      {
        repo: "octo/gizmos",
        number: 7,
        title: "chore: bump toolchain",
        branch: "chore/toolchain",
        state: "open",
        checks: "pending",
        reviewState: "",
        url: "https://github.com/octo/gizmos/pull/7",
        updatedTs: now - 10 * MINUTE,
        dismissedTs: 0,
      },
      {
        repo: "octo/gizmos",
        number: 8,
        title: "docs: attribution notes",
        branch: "docs/attribution",
        state: "open",
        checks: "none",
        reviewState: "",
        url: "https://github.com/octo/gizmos/pull/8",
        updatedTs: now - 26 * 60 * MINUTE,
        dismissedTs: 0,
      },
      {
        repo: "octo/gizmos",
        number: 6,
        title: "feat: task port picker",
        branch: "feat/task-ports",
        state: "merged",
        checks: "passing",
        reviewState: "",
        url: "https://github.com/octo/gizmos/pull/6",
        updatedTs: now - 45 * MINUTE,
        dismissedTs: 0,
      },
    ],
    runs: [],
    dms: [],
    mcpCalls: [
      {
        id: 4,
        ts: now - 12 * 1000,
        method: "tools/call",
        tool: "task_list",
        args: "{}",
        ok: true,
        durationMs: 6,
        client: "claude-code 2.1",
      },
      {
        id: 3,
        ts: now - 40 * 1000,
        method: "tools/call",
        tool: "task_status",
        args: '{"id":2}',
        ok: true,
        durationMs: 3,
        client: "claude-code 2.1",
      },
      {
        id: 2,
        ts: now - 55 * 1000,
        method: "tools/call",
        tool: "task_create",
        args: '{"repo":"gizmos","title":"Wire the MCP screen"}',
        ok: false,
        error: "task_create is disabled: tt-mcp's mutating tools are off until you opt in.",
        durationMs: 1,
        client: "claude-code 2.1",
      },
      {
        id: 1,
        ts: now - 2 * MINUTE,
        method: "initialize",
        ok: true,
        durationMs: 0,
        client: "claude-code 2.1",
      },
    ],
  };
}

/** Lives in `store-snapshot.tsx` (needs JSX); re-exported for its consumers. */
export { useStoreSnapshot } from "./store-snapshot";

/** `2:30 PM` — wall-clock time for an epoch-ms timestamp. */
export function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** `Wed, Jul 22` — weekday + date for an epoch-ms timestamp. */
export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** Below this the countdown switches to `m:ss` and ticks every second, instead
 * of a coarse "1m" the 15s shared clock can leave stale 20s out. */
export const COUNTDOWN_SECONDS_THRESHOLD = 2 * MINUTE;

/** `0:59` / `1:30` (under {@link COUNTDOWN_SECONDS_THRESHOLD}) / `22m` /
 * `1h 05m` — a positive duration; `now` for anything non-positive. */
export function fmtCountdown(msUntil: number): string {
  if (msUntil <= 0) return "now";
  if (msUntil < COUNTDOWN_SECONDS_THRESHOLD) {
    const secs = Math.ceil(msUntil / 1000);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  const mins = Math.round(msUntil / MINUTE);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/** Started but not ended. No `endTs` ⇒ no live window, never live. */
export function eventIsLive(e: CalEvent, now: number): boolean {
  return e.startTs <= now && e.endTs !== undefined && now < e.endTs;
}

/** Mirrors tt-store's `current_or_next_event`, so an in-progress meeting
 * doesn't vanish the instant it starts. */
export function currentOrNextEvent(events: CalEvent[], now: number): CalEvent | undefined {
  return events
    .filter((e) => (e.endTs !== undefined ? now < e.endTs : e.startTs >= now))
    .toSorted((a, b) => a.startTs - b.startTs)[0];
}

/** `just now` / `12m ago` / `3h ago` / `2d ago` — coarse relative age. */
export function fmtAge(ms: number, now: number): string {
  const diff = now - ms;
  if (diff < MINUTE) return "just now";
  const mins = Math.round(diff / MINUTE);
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** This window's checkout (`app_task`): label plus main-vs-task-worktree kind. */
export interface AppTask {
  label: string;
  isWorktree: boolean;
}

/** `null` outside Tauri so the header badge hides. */
export function useAppTask(): AppTask | null {
  const [task, setTask] = useState<AppTask | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    void (async () => {
      const s = await invoke<AppTask>("app_task");
      if (active) setTask(s.unwrapOr(null));
    })();
    return () => {
      active = false;
    };
  }, []);
  return task;
}

/** Create a task; resolves to its id. `status` defaults to Backlog backend-side. */
export const storeAddTask = (text: string, opts?: { status?: TaskStatus; goal?: string }) =>
  invoke<number>("store_add_task", { text, status: opts?.status, goal: opts?.goal });

/** Move a task to another board column (appended at the end of it). */
export const storeSetTaskStatus = (id: number, status: TaskStatus) =>
  invoke<void>("store_set_task_status", { id, status });

export const storeUpdateTask = (id: number, text: string, notes?: string) =>
  invoke<void>("store_update_task", { id, text, notes });

/** Close a task and delete everything bound to it — panes and worktree; the row
 * survives, closed with `outcome` (omitted ⇒ merged linked PR ⇒ done, else
 * abandoned). Guarded — can come back `blocked` having deleted nothing.
 * `purge: true` is the one permanent row delete, refused while a worktree is bound. */
export const taskDelete = (
  target: { id: number } | { dir: string },
  opts?: { force?: boolean; outcome?: TaskOutcome; purge?: boolean },
) =>
  invoke<TaskDeleteOutcome>(
    "task_delete",
    {
      ...target,
      force: opts?.force ?? false,
      outcome: opts?.outcome,
      purge: opts?.purge ?? false,
    },
    { schema: TaskDeleteOutcomeSchema },
  );

/** Archive every closed task — they leave the board but the rows survive. */
export const storeArchiveDone = () => invoke<void>("store_archive_done");

/** Bring one archived task back onto the board. */
export const storeUnarchiveTask = (id: number) => invoke<void>("store_unarchive_task", { id });

/** Open a GitHub issue in `repo` for an existing task and attach the two. */
export const storePromoteTaskToIssue = (id: number, repo: string) =>
  invoke<void>("store_promote_task_to_issue", { id, repo });

export const storeAttachTaskIssue = (id: number, repo: string, number: number, url: string) =>
  invoke<void>("store_attach_task_issue", { id, repo, number, url });

export const storeDetachTaskIssue = (id: number, repo: string, number: number) =>
  invoke<void>("store_detach_task_issue", { id, repo, number });

/** Attach a GitHub PR to a task (worktree-branch PRs auto-attach on collect). */
export const storeAttachTaskPr = (id: number, repo: string, number: number, url: string) =>
  invoke<void>("store_attach_task_pr", { id, repo, number, url });

export const storeDetachTaskPr = (id: number, repo: string, number: number) =>
  invoke<void>("store_detach_task_pr", { id, repo, number });

/** Bind a task to its repo/worktree — at submit with the repo alone, then again
 * with `branch`/`dir` once `task_create` resolves. */
export const storeTaskSetWorktree = (
  id: number,
  repoRoot: string,
  branch: string | undefined,
  opts?: { repo?: string; dir?: string },
) =>
  invoke<void>("store_task_set_worktree", {
    id,
    repoRoot,
    branch,
    repo: opts?.repo,
    dir: opts?.dir,
  });

/** Promote a detected worktree's rail row to the user's own task — a kind
 * change on the existing row, so it keeps its id and rail position. */
export const taskAdoptWorktree = (id: number) => invoke<void>("task_adopt_worktree", { id });

/** Open issues in `dir`'s repo, for the new-task flow's issue picker. */
export const storeGhIssuesList = (dir: string, assignedToMe: boolean) =>
  invoke<IssueItem[]>("store_gh_issues_list", { dir, assignedToMe });

/** Search issues in `dir`'s repo, all states — a task can link any issue. */
export const storeSearchIssues = (dir: string, query: string) =>
  invoke<IssueItem[]>("store_search_issues", { dir, query });

/** Mark a watched Slack DM handled up to `ts`, clearing its banner. */
export const storeDmDismiss = (channel: string, ts: number) =>
  invoke<void>("store_dm_dismiss", { channel, ts });

/** Dismiss one GitHub issue/PR — hidden from the attention feed until the
 * collector observes a newer `updatedTs` than the one passed in. */
export const storeItemDismiss = (
  kind: "issue" | "pr",
  repo: string,
  number: number,
  updatedTs: number,
) => invoke<void>("store_item_dismiss", { kind, repo, number, updatedTs });

/** Clear every dismissed issue/PR at once; resolves to how many were cleared. */
export const storeDismissalsClear = () => invoke<number>("store_dismissals_clear", {});

/** Append a line to today's journal note. */
export const journalLog = (text: string) => invoke<void>("journal_log", { text });

/** Force the issues/PRs/Slack collectors now — calendar excluded (it spends
 * claude tokens). The `boolean` is a domain answer, not success: `true` =
 * kicked off, `false` = one was already in flight. */
export async function storeCollectNow(): Promise<Result<boolean, IpcError>> {
  const result = await invoke<{ started: boolean }>("store_collect_now");
  return result.map((r) => r.started);
}
