import { Result } from "effect";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ListChecksIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { Button, Input, Switch } from "@cloudflare/kumo";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ownerRepoFromOrigin } from "@/lib/agentboard/folder";
import { landingSummaryForDir, type TaskBlocker } from "@/lib/agentboard/landing";
import { requestAgentboardNav } from "@/lib/agentboard/requests";
import { useAgentboardState } from "@/lib/agentboard/state";
import { BlockedDeleteDialog } from "@/components/task-blockers";
import { LandedTodayDialog, WatchedIssues } from "@/components/board-github-bits";
import { issueIndex, issueKey, landedToday, suggestedIssues } from "@/lib/board-github";
import {
  cardPrimary,
  liveCursor,
  moveCursor,
  primaryPr,
  type CursorGrid,
  type CursorMove,
  type CursorTarget,
} from "@/lib/board-cursor";
import { openExternalUrl } from "@/lib/open-url";
import { mouseAction } from "@/lib/shortcut-coach";
import { boardAgentStatus } from "@/lib/board-agent-status";
import { repoAccentStyles, type RepoIdentity } from "@/lib/repo-identity";
import { useBoardGroupByRepo } from "@/lib/board-prefs";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";
import {
  storeArchiveDone,
  storeAttachTaskIssue,
  storeAttachTaskPr,
  storeDetachTaskIssue,
  storeDetachTaskPr,
  storeItemDismiss,
  storePromoteTaskToIssue,
  storeUnarchiveTask,
  taskDelete,
  storeUpdateTask,
  TASK_STATUS_LABEL,
  TASK_STATUSES,
  useStoreSnapshot,
  type IssueItem,
  type PrItem,
  type TaskIssueLink,
  type TaskItem,
  type TaskOutcome,
  type TaskPrLink,
} from "@/lib/data";
import { countByStatus } from "@/lib/board-metrics";
import { matchesTaskFilter } from "@/lib/board-filter";
import {
  bucketByStatus,
  foldRepoKey,
  groupTasksByRepo,
  NO_REPO_GROUP,
  railRepoKeyForTask,
  repoGroupLabel,
  taskRepoKey,
  taskRepoSlug,
  type TaskGroup,
} from "@/lib/board-groups";
import { useFocusTarget } from "@/lib/focus-target";
import { shortcutHint, useShortcuts } from "@/lib/shortcuts";
import { toast } from "@/lib/toast";
import type { IpcError } from "@/lib/errors";
import { useWorkspace } from "@/lib/workspace";
import { Card } from "@/screens/board/card";
import { LaneGlyph } from "@/screens/board/card-bits";

/** Every card action paints an optimistic overlay first, so a dropped write
 * would look like it worked until the next snapshot quietly reverted it. */
async function commit(
  mutation: Promise<Result.Result<unknown, IpcError>>,
  what: string,
): Promise<void> {
  const done = await mutation;
  if (Result.isFailure(done)) toast.error(`Couldn't ${what} — ${done.failure.message}`);
}

/** The board's keys step aside for an open menu or dialog, which owns the keyboard. */
function overlayOpen(): boolean {
  return document.querySelector('[role="menu"], [role="dialog"], [role="alertdialog"]') !== null;
}

/** Optimistic edits (text/notes) applied over a snapshot todo until it
 * re-arrives. */
type TaskEdit = { text?: string; notes?: string | undefined };

/** The synthetic lane key when swimlane grouping is toggled off — one unnamed
 * lane holding every card. Never a real repo key (`taskRepoKey` returns
 * `owner/name`, a path basename, or `NO_REPO_GROUP`). */
const ALL_TASKS_LANE = "__all_tasks__";

/** **This screen does not create tasks** — the Agentboard's `+` flow is the
 * only creator. A card's column is never set by hand either: `backlog`/`doing`
 * follow whether an agent is live on the worktree, `done` follows closing. */
export function BoardScreen() {
  const { snapshot } = useStoreSnapshot();
  const { activeTab, openTab, openTabWithFocus } = useWorkspace();
  // Deep-link focus: a promoted-todo / board deep link scrolls the card here.
  const focusRef = useFocusTarget<HTMLDivElement>("board");
  const filterInputRef = useRef<HTMLInputElement>(null);

  const [editOverrides, setEditOverrides] = useState<Record<number, TaskEdit>>({});
  const [deletedIds, setDeletedIds] = useState<Set<number>>(() => new Set());
  // Optimistic close: the outcome shown on a card whose worktree teardown is
  // still running (a close can take a minute of git work), until the snapshot
  // re-arrives with the recorded one.
  const [closeOverrides, setCloseOverrides] = useState<Record<number, TaskOutcome>>({});
  const [showArchived, setShowArchived] = useState(false);
  // A refused close, held for the dialog that reports it. No name is stored: a
  // refusal deleted nothing, so the dialog reads current text from `merged`.
  // `outcome` rides along so a forced retry records the same answer.
  const [blockedDelete, setBlockedDelete] = useState<{
    id: number;
    outcome?: TaskOutcome;
    blockers: TaskBlocker[];
    messages: string[];
  } | null>(null);
  const [filter, setFilter] = useState("");
  const [landedOpen, setLandedOpen] = useState(false);
  const [watchedOpen, setWatchedOpen] = useState(true);
  const [cursorTarget, setCursorTarget] = useState<CursorTarget | null>(null);
  const cursorScopeRef = useRef<HTMLDivElement>(null);

  const agentState = useAgentboardState();

  // Keyed the way lanes are: GitHub `owner/name`, bridged from each repo's
  // origin URL. From the rail's own snapshot — no second poll.
  const repoByKey = useMemo(() => {
    const m = new Map<string, RepoIdentity>();
    for (const r of agentState.repos) {
      // Folded to match how lanes and cards key themselves — an origin URL's
      // casing need not match the slug a task was stamped with.
      const key = ownerRepoFromOrigin(r.originUrl);
      if (key) m.set(foldRepoKey(key), r);
    }
    return m;
  }, [agentState.repos]);

  // The cache carries settled PRs too, so the rail can badge one; "Attach PR…"
  // only ever offers a PR still worth attaching.
  const openPrs = useMemo(() => snapshot.prs.filter((p) => p.state === "open"), [snapshot.prs]);

  const issuesByKey = useMemo(
    () => issueIndex(snapshot.issues, snapshot.watchedIssues),
    [snapshot.issues, snapshot.watchedIssues],
  );
  const watched = useMemo(
    () => suggestedIssues(snapshot.watchedIssues, snapshot.tasks),
    [snapshot.watchedIssues, snapshot.tasks],
  );
  // Recomputed per snapshot: "today" only needs to be as fresh as the data.
  const landed = useMemo(
    () => landedToday(snapshot.prs, snapshot.tasks, Date.now()),
    [snapshot.prs, snapshot.tasks],
  );

  // The promote-to-issue targets.
  const repos = useMemo(() => {
    const set = new Set<string>();
    for (const p of snapshot.prs) set.add(p.repo);
    for (const i of snapshot.issues) set.add(i.repo);
    for (const t of snapshot.tasks) {
      for (const l of t.issues) set.add(l.repo);
      for (const l of t.prs) set.add(l.repo);
    }
    return [...set].toSorted();
  }, [snapshot.prs, snapshot.issues, snapshot.tasks]);

  const merged = useMemo(
    () =>
      snapshot.tasks
        .filter((t) => !deletedIds.has(t.id))
        .filter((t) => showArchived || t.archivedAt === undefined)
        .map((t) => ({
          ...t,
          ...editOverrides[t.id],
          outcome: closeOverrides[t.id] ?? t.outcome,
        })),
    [snapshot.tasks, editOverrides, deletedIds, closeOverrides, showArchived],
  );

  const visible = useMemo(
    () => merged.filter((t) => matchesTaskFilter(t, filter)),
    [merged, filter],
  );
  const hiddenCount = merged.length - visible.length;
  // A filter hiding every card is a different state from having none.
  const isEmpty = merged.length === 0;

  // Off the raw snapshot, not `merged`: the chip advertises what is hidden.
  const archivedCount = useMemo(
    () => snapshot.tasks.filter((t) => t.archivedAt !== undefined).length,
    [snapshot.tasks],
  );

  // Automatic: a lane is "the tasks that resolved to this repo", so lanes
  // appear and vanish with the work — nothing to create, name, or clean up.
  const grouped = useMemo(() => groupTasksByRepo(visible), [visible]);

  const [groupByRepo, setGroupByRepo] = useBoardGroupByRepo();
  const lanes = useMemo(() => {
    const groups: TaskGroup[] = groupByRepo
      ? grouped
      : [{ key: ALL_TASKS_LANE, slug: ALL_TASKS_LANE, label: "", tasks: visible }];
    return groups.map((g) => ({ ...g, columns: bucketByStatus(g.tasks) }));
  }, [grouped, groupByRepo, visible]);

  // "No repo" is a bucket, not a repo. Counted from the real grouping so the
  // swimlane toggle never changes what the header claims.
  const repoLaneCount = useMemo(
    () => grouped.filter((l) => l.key !== NO_REPO_GROUP).length,
    [grouped],
  );

  // Per-status totals for the sticky header (and the Clear-done gate).
  const counts = useMemo(() => countByStatus(visible), [visible]);

  // Hands off to Agentboard's new-task form bound to the existing id, so
  // submitting mints a fresh worktree for this task rather than a new card.
  // Only offered for a task whose repo is on the rail.
  function reopen(task: TaskItem) {
    const railKey = railRepoKeyForTask(agentState.repos, task);
    const repo = railKey ? agentState.repos.find((r) => r.key === railKey) : undefined;
    if (!repo) {
      toast.error("Couldn't reopen that task — its repo isn't tracked on Agentboard");
      return;
    }
    requestAgentboardNav({
      kind: "reopen-task",
      repoDir: repo.dir,
      repoName: repo.name,
      repoKey: repo.key,
      originUrl: repo.originUrl ?? undefined,
      taskId: task.id,
      goal: task.text,
    });
    openTab("agentboard");
  }

  function railRepoForIssue(issue: IssueItem) {
    const want = foldRepoKey(issue.repo);
    return agentState.repos.find((r) => {
      const key = ownerRepoFromOrigin(r.originUrl);
      return key !== undefined && foldRepoKey(key) === want;
    });
  }

  function startFromIssue(issue: IssueItem) {
    const repo = railRepoForIssue(issue);
    if (!repo) return;
    requestAgentboardNav({
      kind: "new-task-from-issue",
      repoDir: repo.dir,
      repoName: repo.name,
      repoKey: repo.key,
      originUrl: repo.originUrl ?? undefined,
      issue,
    });
    openTab("agentboard");
  }

  function dismissWatched(issue: IssueItem) {
    uiAction("board.dismiss_watched_issue", "board");
    void commit(
      storeItemDismiss("issue", issue.repo, issue.number, issue.updatedTs),
      "dismiss that issue",
    );
  }

  function promote(id: number, repo: string) {
    void commit(storePromoteTaskToIssue(id, repo), "promote that task to an issue");
  }

  function attachIssue(id: number, issue: IssueItem) {
    void commit(storeAttachTaskIssue(id, issue.repo, issue.number, issue.url), "attach that issue");
  }

  function detachIssue(id: number, link: TaskIssueLink) {
    void commit(storeDetachTaskIssue(id, link.repo, link.number), "detach that issue");
  }

  function attachPr(id: number, pr: PrItem) {
    void commit(storeAttachTaskPr(id, pr.repo, pr.number, pr.url), "attach that PR");
  }

  function detachPr(id: number, link: TaskPrLink) {
    void commit(storeDetachTaskPr(id, link.repo, link.number), "detach that PR");
  }

  // Rename re-sends the todo's notes too (`storeUpdateTask` is a full replace
  // of text/notes), reading them from `merged` so chained optimistic edits
  // compose.
  function rename(id: number, text: string) {
    const trimmed = text.trim();
    const current = merged.find((t) => t.id === id);
    if (!current || !trimmed || trimmed === current.text) return;
    setEditOverrides((prev) => ({ ...prev, [id]: { ...prev[id], text: trimmed } }));
    void commit(storeUpdateTask(id, trimmed, current.notes), "rename that todo");
  }

  function setNotes(id: number, notes: string) {
    const current = merged.find((t) => t.id === id);
    if (!current) return;
    // Empty/whitespace-only notes clear the field back to unset.
    const value = notes.trim() === "" ? undefined : notes;
    setEditOverrides((prev) => ({ ...prev, [id]: { ...prev[id], notes: value } }));
    void commit(storeUpdateTask(id, current.text, value), "save those notes");
  }

  /** Close paints the outcome optimistically (the git teardown can take a
   * minute); purge hides the card. A guarded refusal reverts either — nothing
   * changed, so the overlay would show a close that didn't happen. */
  async function remove(
    id: number,
    {
      force = false,
      outcome,
      purge = false,
    }: { force?: boolean; outcome?: TaskOutcome; purge?: boolean } = {},
  ) {
    if (purge) setDeletedIds((prev) => new Set(prev).add(id));
    else if (outcome) setCloseOverrides((prev) => ({ ...prev, [id]: outcome }));
    const done = await taskDelete({ id }, { force, outcome, purge });
    const revert = () => {
      setDeletedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setCloseOverrides((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    };
    Result.match(done, {
      onSuccess: (result) => {
        if (result.status === "blocked") {
          revert();
          // Refused, not failed: the reasons come with remedies, so they go to
          // a dialog that can act on them rather than a dismissable toast.
          setBlockedDelete({ id, outcome, blockers: result.blockers, messages: result.messages });
          return;
        }
        for (const message of result.messages) toast(message);
      },
      onFailure: (e) => {
        revert();
        toast.error(`Couldn't ${purge ? "delete" : "close"} that task — ${e.message}`);
      },
    });
  }

  function restore(id: number) {
    uiAction("board.unarchive_task", "board");
    void commit(storeUnarchiveTask(id), "restore that task");
  }

  function archiveDone() {
    uiAction("board.archive_done", "board");
    void commit(storeArchiveDone(), "archive the Closed column");
  }

  // `railKey` is resolved per card at render, so a card whose repo isn't on
  // the rail simply doesn't offer the jump.
  const openOnAgentboard = useCallback(
    (railKey: string) => {
      openTabWithFocus({ screen: "agentboard", kind: "repo", id: railKey });
    },
    [openTabWithFocus],
  );

  const openSession = useCallback(
    (folderDir: string, sessionId: string) => {
      uiAction("board.open_agent_session", "board");
      requestAgentboardNav({ kind: "session", folderDir, sessionId });
      openTab("agentboard");
    },
    [openTab],
  );

  const cursorGrid = useMemo<CursorGrid>(
    () => ({
      issues: watchedOpen ? watched.map((i) => issueKey(i.repo, i.number)) : [],
      lanes: lanes.map((lane) => TASK_STATUSES.map((s) => lane.columns[s].map((t) => t.id))),
    }),
    [watched, watchedOpen, lanes],
  );
  const cursor = liveCursor(cursorGrid, cursorTarget);
  const cursorTask = cursor?.kind === "task" ? visible.find((t) => t.id === cursor.id) : undefined;
  const cursorIssue =
    cursor?.kind === "issue"
      ? watched.find((i) => issueKey(i.repo, i.number) === cursor.key)
      : undefined;

  // Keep the ring on screen. The sticky status row is cleared by the card's
  // own `scroll-mt`.
  useEffect(() => {
    if (cursor) {
      cursorScopeRef.current
        ?.querySelector("[data-board-cursor]")
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [cursor]);

  // Board-scoped shortcuts (see lib/shortcuts.tsx for the registry). Gated on
  // the tab being active: this screen stays mounted while hidden, so without
  // the gate "j"/"/" would steal keystrokes from whatever tab is showing.
  // A handler returning false declines, leaving the key to whoever else wants
  // it: an open menu or dialog, a focused button's native Enter.
  const step = (move: CursorMove) => () => {
    if (overlayOpen()) return false;
    const next = moveCursor(cursorGrid, cursor, move);
    if (!next) return false;
    // A clicked button keeps focus, and would swallow the next Enter.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && cursorScopeRef.current?.contains(focused)) {
      focused.blur();
    }
    setCursorTarget(next);
  };
  const onButton = () => {
    const focused = document.activeElement;
    return (
      focused instanceof HTMLElement &&
      cursorScopeRef.current?.contains(focused) === true &&
      focused.closest("button, a") !== null
    );
  };
  useShortcuts(
    {
      "board-filter": () => filterInputRef.current?.focus(),
      "board-down": step("down"),
      "board-up": step("up"),
      "board-left": step("left"),
      "board-right": step("right"),
      "board-open": () => {
        if (overlayOpen() || onButton() || !cursorTask) return false;
        const railKey = railRepoKeyForTask(agentState.repos, cursorTask);
        if (!railKey || cardPrimary(cursorTask, true) !== "open") return false;
        openOnAgentboard(railKey);
      },
      "board-start": () => {
        if (overlayOpen()) return false;
        if (cursorIssue) {
          if (!railRepoForIssue(cursorIssue)) return false;
          startFromIssue(cursorIssue);
          return;
        }
        if (!cursorTask) return false;
        const onRail = railRepoKeyForTask(agentState.repos, cursorTask) !== null;
        if (cardPrimary(cursorTask, onRail) !== "start") return false;
        reopen(cursorTask);
      },
      "board-open-link": () => {
        if (overlayOpen()) return false;
        const url = cursorIssue?.url ?? (cursorTask ? primaryPr(cursorTask)?.url : undefined);
        if (!url) return false;
        void openExternalUrl(url);
      },
      "board-cursor-clear": () => {
        if (overlayOpen() || !cursor) return false;
        setCursorTarget(null);
      },
    },
    "board",
    activeTab === "board",
  );

  const blockedTask = merged.find((t) => t.id === blockedDelete?.id);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2.5">
        <h2 className="text-sm font-medium">Board</h2>
        <span className="text-xs text-muted-foreground">
          {repoLaneCount} {repoLaneCount === 1 ? "repo" : "repos"} · {snapshot.tasks.length} tasks
        </span>
        {filter.trim() !== "" && hiddenCount > 0 && (
          <span className="text-xs text-muted-foreground">{hiddenCount} hidden</span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {/* `htmlFor`, never a wrapping label: the switch is a <button>, and a
              label wrapped around it forwards each click back into it — two
              toggles per click, net nothing. */}
          <label htmlFor="board-swimlanes" className="cursor-pointer text-xs text-kumo-subtle">
            Swimlanes
          </label>
          <Switch
            id="board-swimlanes"
            checked={groupByRepo}
            onCheckedChange={(v) => {
              setGroupByRepo(v);
              uiAction("board.group_by_repo", "board", v ? "on" : "off");
            }}
            aria-label="Group tasks into repo swimlanes"
          />
          {archivedCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "px-2 font-mono text-mini",
                showArchived ? "text-kumo-default" : "text-kumo-subtle",
              )}
              title={
                showArchived
                  ? "Hide archived tasks"
                  : "Show archived tasks, dimmed, in their columns"
              }
              aria-pressed={showArchived}
              onClick={() => {
                setShowArchived((v) => !v);
                uiAction("board.show_archived", "board", showArchived ? "off" : "on");
              }}
            >
              Archived · {archivedCount}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="px-2 font-mono text-mini text-kumo-subtle"
            title="Your PRs merged and tasks done since midnight, with today's journal"
            onClick={() => {
              setLandedOpen(true);
              uiAction("board.landed_today", "board");
            }}
          >
            Landed today · {landed.prs.length + landed.tasks.length}
          </Button>
          {counts.done > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="px-2 text-xs text-kumo-subtle"
              title="Archive all closed tasks now — hidden, not deleted"
              onClick={archiveDone}
            >
              Archive done
            </Button>
          )}
          <div className="relative w-44">
            <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              size="xs"
              ref={filterInputRef}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setFilter("");
              }}
              placeholder={`Filter…  ${shortcutHint("board-filter")}`}
              className="pl-7"
              spellCheck={false}
              aria-label="Filter tasks"
            />
          </div>
        </div>
      </div>

      {isEmpty ? (
        <div ref={focusRef} className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="flex max-w-sm flex-col items-center gap-2 text-center">
            <ListChecksIcon aria-hidden className="size-8 text-muted-foreground/50" />
            <p className="text-sm font-medium">No tasks yet</p>
            <p className="text-xs text-muted-foreground">
              Tasks are created on the{" "}
              <span className="font-medium text-foreground">Agentboard</span> — hit{" "}
              <span className="font-medium text-foreground">+</span> on a repo to start one. It
              shows up here, in that repo&apos;s lane, the moment you submit.
            </p>
          </div>
        </div>
      ) : visible.length === 0 ? (
        <div ref={focusRef} className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="flex max-w-sm flex-col items-center gap-2 text-center">
            <MagnifyingGlassIcon aria-hidden className="size-8 text-muted-foreground/50" />
            <p className="text-sm font-medium">No tasks match your filter</p>
            <p className="text-xs text-muted-foreground">
              All {merged.length} {merged.length === 1 ? "task is" : "tasks are"} hidden by “
              {filter.trim()}”.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-1"
              onClick={() => {
                setFilter("");
                uiAction("board.clear_filter", "board");
                filterInputRef.current?.focus();
              }}
            >
              Clear filter
            </Button>
          </div>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div ref={focusRef} className="min-w-[900px] p-3">
            <div ref={cursorScopeRef}>
              <WatchedIssues
                issues={watched}
                open={watchedOpen}
                onOpenChange={setWatchedOpen}
                cursorKey={cursorIssue ? issueKey(cursorIssue.repo, cursorIssue.number) : null}
                canStart={(issue) =>
                  railRepoForIssue(issue) ? null : `${issue.repo} isn't tracked on Agentboard`
                }
                onStart={(issue) => {
                  mouseAction("board-start", "board");
                  startFromIssue(issue);
                }}
                onDismiss={dismissWatched}
              />
              {/* One status header for the whole board — the columns are shared
                across every lane, so repeating the labels per lane would be
                mostly noise. Sticky so they stay readable while scrolling
                a long list of repos. */}
              <div className="sticky top-0 z-10 grid grid-cols-3 gap-3 bg-background pb-2">
                {TASK_STATUSES.map((status) => (
                  <div key={status} className="flex items-center justify-between gap-1 px-2.5">
                    <span className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {TASK_STATUS_LABEL[status]}
                    </span>
                    <span className="rounded-full bg-muted px-1.5 font-mono text-micro text-muted-foreground">
                      {counts[status]}
                    </span>
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-4">
                {lanes.map((lane) => {
                  const laneRepo =
                    lane.key === ALL_TASKS_LANE ? undefined : repoByKey.get(lane.key);
                  const laneAccent = repoAccentStyles(laneRepo);
                  return (
                    <section key={lane.key}>
                      {/* Flat mode's single lane is every repo's, so it gets no
                      header — the sticky status row above is enough. */}
                      {lane.key !== ALL_TASKS_LANE && (
                        <div
                          // A transparent edge keeps unthemed lanes aligned with
                          // themed ones.
                          className="mb-1 flex items-center gap-1.5 rounded-md border-l-2 border-l-transparent px-1.5 py-1"
                          style={{ ...laneAccent.edgeStyle, ...laneAccent.surfaceStyle }}
                        >
                          <LaneGlyph repo={laneRepo} />
                          <span
                            className={cn(
                              // `pr-px`: the italic variant's final glyph overhangs
                              // its content box, and `truncate`'s overflow:hidden
                              // clips the overhang without ever showing an ellipsis.
                              "truncate pr-px text-sm font-semibold",
                              lane.key === NO_REPO_GROUP &&
                                "font-normal italic text-muted-foreground",
                            )}
                            title={lane.key === NO_REPO_GROUP ? undefined : lane.slug}
                          >
                            {lane.label}
                          </span>
                          <span className="rounded-full bg-muted px-1.5 font-mono text-micro text-muted-foreground">
                            {lane.tasks.length}
                          </span>
                        </div>
                      )}
                      <div className="grid grid-cols-3 gap-3">
                        {TASK_STATUSES.map((status) => (
                          <div
                            key={status}
                            className="flex min-h-12 flex-col gap-2 rounded-lg border bg-muted/30 p-2"
                          >
                            {lane.columns[status].map((task) => {
                              const repoKey = taskRepoKey(task);
                              const repoSlug = taskRepoSlug(task);
                              const railKey = railRepoKeyForTask(agentState.repos, task);
                              return (
                                <Card
                                  key={task.id}
                                  task={task}
                                  repos={repos}
                                  repoIdentity={repoByKey.get(repoKey)}
                                  repoLabel={
                                    groupByRepo || repoKey === NO_REPO_GROUP
                                      ? undefined
                                      : repoGroupLabel(repoSlug)
                                  }
                                  onOpenAgentboard={
                                    railKey
                                      ? () => {
                                          mouseAction("board-open", "board");
                                          openOnAgentboard(railKey);
                                        }
                                      : undefined
                                  }
                                  agent={boardAgentStatus(agentState.repos, task.worktree?.dir)}
                                  cursor={cursorTask?.id === task.id}
                                  onOpenSession={openSession}
                                  openIssues={snapshot.issues}
                                  issuesByKey={issuesByKey}
                                  openPrs={openPrs}
                                  onReopen={(t) => {
                                    uiAction("board.reopen_task", "board");
                                    reopen(t);
                                  }}
                                  onStart={(t) => {
                                    mouseAction("board-start", "board");
                                    reopen(t);
                                  }}
                                  onPromote={promote}
                                  onAttachIssue={attachIssue}
                                  onDetachIssue={detachIssue}
                                  onAttachPr={attachPr}
                                  onDetachPr={detachPr}
                                  onRename={rename}
                                  onSetNotes={setNotes}
                                  onClose={(id, outcome) => void remove(id, { outcome })}
                                  onRestore={restore}
                                  onPurge={(id) => void remove(id, { purge: true })}
                                />
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    </section>
                  );
                })}
              </div>
            </div>
          </div>
        </ScrollArea>
      )}

      <LandedTodayDialog open={landedOpen} onOpenChange={setLandedOpen} landed={landed} />

      <BlockedDeleteDialog
        open={blockedDelete != null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setBlockedDelete(null);
        }}
        name={blockedTask?.text}
        landing={
          blockedTask?.worktree?.dir
            ? landingSummaryForDir(agentState.repos, snapshot.prs, blockedTask.worktree.dir)
            : undefined
        }
        description="This task’s worktree still holds work. Clear what’s below and it’ll close cleanly, or close anyway."
        cancelLabel="Keep the task"
        blockers={blockedDelete?.blockers ?? []}
        messages={blockedDelete?.messages ?? []}
        onForce={() => {
          if (blockedDelete) {
            const { id, outcome } = blockedDelete;
            setBlockedDelete(null);
            void remove(id, { force: true, outcome });
          }
        }}
      />
    </div>
  );
}
