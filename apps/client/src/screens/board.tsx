import { useCallback, useMemo, useRef, useState } from "react";
import { FolderGit2, ListTodo, MoreHorizontal, Search, StickyNote } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import {
  ownerRepoFromOrigin,
  requestAgentboardNav,
  type TaskBlocker,
  useAgentboardState,
} from "@/lib/agentboard";
import { BlockedDeleteDialog } from "@/components/task-blockers";
import { repoAccentStyles, repoIcon, type RepoMeta } from "@/lib/repo-identity";
import { useBoardGroupByRepo } from "@/lib/board-prefs";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";
import {
  storeArchiveDone,
  storeAttachTaskIssue,
  storeAttachTaskPr,
  storeDetachTaskIssue,
  storeDetachTaskPr,
  storePromoteTaskToIssue,
  storeUnarchiveTask,
  taskDelete,
  storeUpdateTask,
  fmtClock,
  fmtDate,
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
import { taskRollup } from "@/lib/board-rollup";
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
import { openExternalUrl } from "@/lib/open-url";
import { PR_TONE, prTone } from "@/lib/pr-tone";
import { shortcutHint, useShortcuts } from "@/lib/shortcuts";
import { toast } from "sonner";
import type { Result } from "better-result";
import type { IpcError } from "@/lib/errors";
import { useWorkspace } from "@/lib/workspace";

/** Every card action paints an optimistic overlay first, so a dropped write
 * would look like it worked until the next snapshot quietly reverted it. */
async function commit(mutation: Promise<Result<unknown, IpcError>>, what: string): Promise<void> {
  const done = await mutation;
  if (done.isErr()) toast.error(`Couldn't ${what} — ${done.error.message}`);
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

  // Board-scoped shortcuts (see lib/shortcuts.tsx for the registry). Gated on
  // the tab being active: this screen stays mounted while hidden, so without
  // the gate "n"/"/" would steal keystrokes from whatever tab is showing.
  useShortcuts(
    useMemo(
      () => ({
        "board-filter": () => filterInputRef.current?.focus(),
      }),
      [],
    ),
    "board",
    activeTab === "board",
  );
  const agentState = useAgentboardState();

  // Keyed the way lanes are: GitHub `owner/name`, bridged from each repo's
  // origin URL. From the rail's own snapshot — no second poll.
  const repoMetaByKey = useMemo(() => {
    const m = new Map<string, RepoMeta>();
    for (const r of agentState.repos) {
      if (!r.meta) continue;
      // Folded to match how lanes and cards key themselves — an origin URL's
      // casing need not match the slug a task was stamped with.
      const key = ownerRepoFromOrigin(r.originUrl);
      if (key) m.set(foldRepoKey(key), r.meta);
    }
    return m;
  }, [agentState.repos]);

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
    uiAction("board.reopen_task", "board");
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
    done.match({
      ok: (result) => {
        if (result.status === "blocked") {
          revert();
          // Refused, not failed: the reasons come with remedies, so they go to
          // a dialog that can act on them rather than a dismissable toast.
          setBlockedDelete({ id, outcome, blockers: result.blockers, messages: result.messages });
          return;
        }
        for (const message of result.messages) toast(message);
      },
      err: (e) => {
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
      uiAction("board.open_agentboard", "board");
      openTabWithFocus({ screen: "agentboard", kind: "repo", id: railKey });
    },
    [openTabWithFocus],
  );

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
          <label htmlFor="board-swimlanes" className="cursor-pointer text-xs text-muted-foreground">
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
                "px-2 font-mono text-[11px]",
                showArchived ? "text-foreground" : "text-muted-foreground",
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
          {counts.done > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="px-2 text-xs text-muted-foreground"
              title="Archive all closed tasks now — hidden, not deleted"
              onClick={archiveDone}
            >
              Archive done
            </Button>
          )}
          <div className="relative w-44">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={filterInputRef}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setFilter("");
              }}
              placeholder={`Filter…  ${shortcutHint("board-filter")}`}
              className="h-7 pl-7 text-sm"
              spellCheck={false}
              aria-label="Filter tasks"
            />
          </div>
        </div>
      </div>

      {isEmpty ? (
        <div ref={focusRef} className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="flex max-w-sm flex-col items-center gap-2 text-center">
            <ListTodo aria-hidden className="size-8 text-muted-foreground/50" />
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
            <Search aria-hidden className="size-8 text-muted-foreground/50" />
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
                  <span className="rounded-full bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
                    {counts[status]}
                  </span>
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-4">
              {lanes.map((lane) => {
                const laneMeta =
                  lane.key === ALL_TASKS_LANE ? undefined : repoMetaByKey.get(lane.key);
                const laneAccent = repoAccentStyles(laneMeta);
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
                        <LaneGlyph meta={laneMeta} />
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
                        <span className="rounded-full bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
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
                                repoMeta={repoMetaByKey.get(repoKey)}
                                repoLabel={
                                  groupByRepo || repoKey === NO_REPO_GROUP
                                    ? undefined
                                    : repoGroupLabel(repoSlug)
                                }
                                onOpenAgentboard={
                                  railKey ? () => openOnAgentboard(railKey) : undefined
                                }
                                openIssues={snapshot.issues}
                                openPrs={snapshot.prs}
                                onReopen={reopen}
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
        </ScrollArea>
      )}

      <BlockedDeleteDialog
        open={blockedDelete != null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setBlockedDelete(null);
        }}
        name={merged.find((t) => t.id === blockedDelete?.id)?.text}
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

/** Seeded each time the menu opens (Radix unmounts content on close) and
 * committed on blur, so the store isn't written per keystroke. */
function NotesField({
  task,
  onSetNotes,
}: {
  task: TaskItem;
  onSetNotes: (id: number, notes: string) => void;
}) {
  const [draft, setDraft] = useState(task.notes ?? "");
  return (
    <Textarea
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft.trim() !== (task.notes ?? "").trim()) onSetNotes(task.id, draft);
      }}
      placeholder="Add notes…"
      rows={3}
      className="min-h-16 resize-none text-xs"
      aria-label="Todo notes"
    />
  );
}

function LaneGlyph({ meta }: { meta?: RepoMeta }) {
  if (!meta) {
    return <FolderGit2 aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  const Icon = repoIcon(meta);
  return (
    <Icon
      aria-hidden
      className="size-3.5 shrink-0 text-muted-foreground"
      style={repoAccentStyles(meta).iconStyle}
    />
  );
}

function Card({
  task,
  repos,
  repoMeta,
  repoLabel,
  onOpenAgentboard,
  openIssues,
  openPrs,
  onReopen,
  onPromote,
  onAttachIssue,
  onDetachIssue,
  onAttachPr,
  onDetachPr,
  onRename,
  onSetNotes,
  onClose,
  onRestore,
  onPurge,
}: {
  task: TaskItem;
  repos: string[];
  repoMeta?: RepoMeta;
  /** Set only in flat (no-swimlane) mode, where no lane header names the repo. */
  repoLabel?: string;
  /** Undefined when the repo isn't on the rail — the affordances don't render. */
  onOpenAgentboard?: () => void;
  openIssues: IssueItem[];
  openPrs: PrItem[];
  /** Mints a fresh worktree bound to the task's existing id — both reopening a
   * closed task and starting a worktree-less "task only" one. */
  onReopen: (task: TaskItem) => void;
  onPromote: (id: number, repo: string) => void;
  onAttachIssue: (id: number, issue: IssueItem) => void;
  onDetachIssue: (id: number, link: TaskIssueLink) => void;
  onAttachPr: (id: number, pr: PrItem) => void;
  onDetachPr: (id: number, link: TaskPrLink) => void;
  onRename: (id: number, text: string) => void;
  onSetNotes: (id: number, notes: string) => void;
  /** Removes the worktree/panes, keeps the row. */
  onClose: (id: number, outcome: TaskOutcome) => void;
  onRestore: (id: number) => void;
  /** Only offered when no worktree is bound. */
  onPurge: (id: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(task.text);
  // What the confirm dialog is confirming: a close (with the chosen outcome,
  // worktree-bound tasks only — a bare row closes without asking) or a purge.
  const [confirming, setConfirming] = useState<
    { kind: "close"; outcome: TaskOutcome } | { kind: "purge" } | null
  >(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const hasNotes = (task.notes ?? "").trim() !== "";
  const summary = (task.summary ?? "").trim();
  // Derived backend-side (`TaskItem::with_derived_fields`) so every consumer
  // agrees. No worktree means the useful action is starting/reopening one,
  // not a dead-end navigation to an empty rail row.
  const { closed, hasWorktree } = task;
  const outcome = task.displayOutcome ?? null;
  const archived = task.archivedAt !== undefined;
  const attachableIssues = openIssues.filter(
    (i) => !task.issues.some((l) => l.repo === i.repo && l.number === i.number),
  );
  const attachablePrs = openPrs.filter(
    (p) => !task.prs.some((l) => l.repo === p.repo && l.number === p.number),
  );
  const hasLinks = task.issues.length > 0 || task.prs.length > 0;
  // The collector moves a fully-resolved linked task to `done` on its own, so
  // a card can finish without anyone touching it (see `lib/board-rollup.ts`).
  const rollup = taskRollup(task);
  const rollupTitle = rollup
    ? [
        "Moved to done automatically — every linked issue and PR is resolved:",
        ...rollup.evidence.map((e) => `  ${e.qualified} ${e.state}`),
        task.completedAt !== undefined &&
          `Done ${fmtDate(task.completedAt)} at ${fmtClock(task.completedAt)}`,
      ]
        .filter(Boolean)
        .join("\n")
    : undefined;
  // The wash mixes into the card's own opaque background.
  const accent = repoAccentStyles(repoMeta, "var(--background)");
  const RepoGlyph = repoMeta ? repoIcon(repoMeta) : null;
  const identityStyle = { ...accent.edgeStyle, ...accent.surfaceStyle };
  const branch = task.worktree?.branch;
  const detached = branch !== undefined && !hasWorktree;
  const identityRowText = [repoLabel, branch && `⎇ ${branch}${detached ? " · detached" : ""}`]
    .filter(Boolean)
    .join(" · ");

  function startRename() {
    setEditValue(task.text);
    setEditing(true);
  }

  function commitRename() {
    setEditing(false);
    onRename(task.id, editValue);
  }

  return (
    <div
      data-focus-kind="todo"
      data-focus-id={String(task.id)}
      className={cn(
        "group rounded-md border border-l-2 bg-background p-2.5 text-sm shadow-sm",
        closed && "opacity-60",
        archived && "opacity-40",
      )}
      style={identityStyle}
    >
      <div className="flex items-start gap-1.5">
        {RepoGlyph && (
          <RepoGlyph
            aria-hidden
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            style={accent.iconStyle}
          />
        )}
        {editing ? (
          <Input
            ref={inputRef}
            autoFocus
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setEditing(false);
            }}
            onBlur={commitRename}
            className="h-6 min-w-0 flex-1 px-1.5 py-0 text-sm"
            aria-label="Rename todo"
          />
        ) : (
          <span
            onDoubleClick={startRename}
            // Only done work is struck through — an abandoned task ended, but
            // striking it would claim it was finished.
            className={cn("min-w-0 flex-1", outcome === "done" && "line-through")}
          >
            {task.text}
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="-mr-1 -mt-1 size-6"
              aria-label="Todo actions"
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {hasWorktree && onOpenAgentboard ? (
              <>
                <DropdownMenuItem onSelect={onOpenAgentboard}>Open on Agentboard</DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            ) : (
              !closed && (
                <>
                  <DropdownMenuItem onSelect={() => onReopen(task)}>
                    Start task
                    <span className="ml-auto text-[10px] text-muted-foreground">new worktree</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )
            )}
            <DropdownMenuItem onSelect={startRename}>Rename</DropdownMenuItem>
            <DropdownMenuLabel className="pb-0.5 pt-1 text-muted-foreground">
              Notes
            </DropdownMenuLabel>
            <div
              className="px-2 py-1"
              // Keep the menu open and stop its typeahead from eating keystrokes.
              onKeyDown={(e) => e.stopPropagation()}
            >
              <NotesField task={task} onSetNotes={onSetNotes} />
            </div>
            {closed && !archived && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onReopen(task)}>
                  Reopen
                  <span className="ml-auto text-[10px] text-muted-foreground">new worktree</span>
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
            {attachableIssues.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Attach issue…</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
                  {attachableIssues.map((issue) => (
                    <DropdownMenuItem
                      key={`${issue.repo}#${issue.number}`}
                      onSelect={() => onAttachIssue(task.id, issue)}
                    >
                      <span className="mr-1.5 font-mono text-muted-foreground">
                        #{issue.number}
                      </span>
                      <span className="max-w-56 truncate">{issue.title}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {attachablePrs.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Attach PR…</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
                  {attachablePrs.map((pr) => (
                    <DropdownMenuItem
                      key={`${pr.repo}#${pr.number}`}
                      onSelect={() => onAttachPr(task.id, pr)}
                    >
                      <span className="mr-1.5 font-mono text-muted-foreground">#{pr.number}</span>
                      <span className="max-w-56 truncate">{pr.title}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {hasLinks && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Detach…</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {task.issues.map((link) => (
                    <DropdownMenuItem
                      key={`i${link.repo}#${link.number}`}
                      onSelect={() => onDetachIssue(task.id, link)}
                    >
                      issue #{link.number} · {link.repo}
                    </DropdownMenuItem>
                  ))}
                  {task.prs.map((link) => (
                    <DropdownMenuItem
                      key={`p${link.repo}#${link.number}`}
                      onSelect={() => onDetachPr(task.id, link)}
                    >
                      PR #{link.number} · {link.repo}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {repos.length > 0 ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Create issue in…</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {repos.map((repo) => (
                    <DropdownMenuItem key={repo} onSelect={() => onPromote(task.id, repo)}>
                      {repo}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : (
              <DropdownMenuItem disabled>No repos to file in</DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            {/* How a task ends. Open tasks close with an outcome (taking their
                worktree with them — confirmed when one exists, immediate for a
                bare row). Archived ones can come back. The permanent delete
                survives only for rows with no worktree bound — the backend
                refuses it otherwise. */}
            {!closed && (
              <>
                <DropdownMenuItem
                  onSelect={() =>
                    hasWorktree
                      ? setConfirming({ kind: "close", outcome: "done" })
                      : onClose(task.id, "done")
                  }
                >
                  Close as done
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    hasWorktree
                      ? setConfirming({ kind: "close", outcome: "abandoned" })
                      : onClose(task.id, "abandoned")
                  }
                >
                  Close as abandoned
                </DropdownMenuItem>
              </>
            )}
            {archived && (
              <DropdownMenuItem onSelect={() => onRestore(task.id)}>Restore</DropdownMenuItem>
            )}
            {!hasWorktree && (
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setConfirming({ kind: "purge" })}
              >
                Delete permanently…
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* The goal the task was created for — only when it says something the
          title doesn't already (a goal-less-title submit stores the same
          text in both). */}
      {task.goal && task.goal !== task.text && (
        <div className="mt-1.5 truncate text-xs text-muted-foreground" title={task.goal}>
          {task.goal}
        </div>
      )}

      {/* The identity row: the repo name in flat mode (where no lane header
          says it), plus the worktree branch when one exists — a branchless task in
          grouped mode renders nothing here, its lane header already identifies
          it. Clickable when the repo has an Agentboard rail row. */}
      {(repoLabel !== undefined || branch) && (
        <div
          className={cn(
            "mt-1.5 flex items-center font-mono text-[11px] text-muted-foreground",
            detached && "italic text-muted-foreground/70",
          )}
        >
          {hasWorktree && onOpenAgentboard ? (
            <button
              type="button"
              onClick={onOpenAgentboard}
              title={`Open on Agentboard — ${task.worktree?.dir}`}
              className="min-w-0 truncate text-left hover:text-foreground hover:underline"
            >
              {identityRowText}
            </button>
          ) : !closed ? (
            <button
              type="button"
              onClick={() => onReopen(task)}
              title="Start this task — mints a new worktree"
              className="min-w-0 truncate text-left hover:text-foreground hover:underline"
            >
              {identityRowText}
            </button>
          ) : (
            <span
              className="min-w-0 truncate"
              title={
                task.worktree?.dir ?? (branch ? `worktree removed — branch ${branch}` : undefined)
              }
            >
              {identityRowText}
            </span>
          )}
        </div>
      )}
      {(hasLinks || hasNotes || closed) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {/* How the task ended: ✓ teal for done, ⊘ muted for abandoned — the
              one honest terminal column needs the badge to say which. */}
          {outcome && (
            <Badge
              variant="outline"
              className={cn(
                "gap-1 font-mono text-[10px]",
                outcome === "done" ? "text-emerald-500" : "text-muted-foreground",
              )}
            >
              {outcome === "done" ? "✓ done" : "⊘ abandoned"}
            </Badge>
          )}
          {archived && (
            <Badge variant="outline" className="text-[10px] text-muted-foreground/70">
              archived
            </Badge>
          )}
          {task.issues.map((link) => (
            <a
              key={`i${link.repo}#${link.number}`}
              href={link.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                e.preventDefault();
                void openExternalUrl(link.url);
              }}
              title={`${link.repo}#${link.number} · ${link.state}`}
              className={cn(
                "font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline",
                link.state === "closed" && "line-through opacity-60",
              )}
            >
              #{link.number}
            </a>
          ))}
          {task.prs.map((link) => {
            // Compact link chips stay muted unless something is settled or
            // wrong — running/passing/plain would be noise at this size.
            const tone = prTone(link);
            return (
              <a
                key={`p${link.repo}#${link.number}`}
                href={link.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => {
                  e.preventDefault();
                  void openExternalUrl(link.url);
                }}
                title={`${link.repo}#${link.number} · ${link.state}${link.checks !== "none" ? ` · checks ${link.checks}` : ""}`}
                className={cn(
                  "font-mono text-[11px] hover:underline",
                  tone === "merged" || tone === "failed"
                    ? PR_TONE[tone].text
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                PR #{link.number}
                {link.state === "merged" && " ✓"}
              </a>
            );
          })}
          {hasNotes && (
            <Badge
              variant="outline"
              className="gap-1 text-[10px] text-muted-foreground"
              title={task.notes}
            >
              <StickyNote aria-hidden className="size-3" />
              Notes
            </Badge>
          )}
        </div>
      )}
      {/* Why a card nobody closed is sitting in `done`. The chips above carry
          the same states, but as decoration — this names the refs as the
          cause, so an unexpectedly-finished card is self-explaining rather
          than something to go re-derive on GitHub. */}
      {rollup && (
        <p className="mt-1 text-[11px] leading-tight text-muted-foreground" title={rollupTitle}>
          Rolled up — {rollup.summary}
        </p>
      )}

      {/* What the agent reported when it finished (MCP `task_summary`). This
          is the card's copy of a wrap-up that otherwise dies with the
          worktree's terminal, and it's what the user reads to confirm the
          work before closing the task — so it renders inline, not behind a
          tooltip like `notes`. Collapsed to a few lines; click to expand. */}
      {summary && (
        <button
          type="button"
          onClick={() => setSummaryOpen((open) => !open)}
          className="mt-2 block w-full rounded border border-dashed bg-muted/30 p-1.5 text-left"
        >
          <span className="mb-0.5 flex items-baseline gap-1.5 text-[10px] text-muted-foreground">
            <span className="font-medium uppercase tracking-wide">Summary</span>
            {task.summaryAt !== undefined && (
              <span className="opacity-70">
                {fmtDate(task.summaryAt)} {fmtClock(task.summaryAt)}
              </span>
            )}
            {/* The affordance: cropped text alone doesn't say it's cropped. */}
            <span className="ml-auto opacity-70">{summaryOpen ? "less" : "more"}</span>
          </span>
          <span
            className={cn(
              "block whitespace-pre-wrap text-[11px] leading-snug text-foreground/80",
              // Height, not `line-clamp-*`: WebKitGTK reports the clamp but
              // ignores it once `whitespace-pre-wrap` gives the text hard
              // newlines. A max-height crops with no engine dependency.
              !summaryOpen && "max-h-16 overflow-hidden",
            )}
          >
            {summary}
          </span>
        </button>
      )}

      <AlertDialog open={confirming != null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming?.kind === "purge"
                ? "Delete this task permanently?"
                : `Close as ${confirming?.outcome ?? "done"}?`}
            </AlertDialogTitle>
            {/* Close names the worktree: it deletes the checkout on disk and
                its terminals, and a confirm that only mentioned the card would
                be understating what the button does. Still promises the
                guards — work that would be lost stops the close and reopens
                as the blocked dialog, which is where discarding is agreed
                to. */}
            <AlertDialogDescription>
              {confirming?.kind === "purge"
                ? `“${task.text}” and its record will be removed for good. Closed tasks are normally archived, not deleted — this is the exception.`
                : `“${task.text}” stays on the board as ${
                    confirming?.outcome ?? "done"
                  }, but its worktree and any terminals in it will be removed. Uncommitted or unlanded work stops the close rather than being discarded.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirming?.kind === "purge") onPurge(task.id);
                else if (confirming) onClose(task.id, confirming.outcome);
                setConfirming(null);
              }}
              className={cn(
                confirming?.kind === "purge" && "bg-red-600 text-white hover:bg-red-600/90",
              )}
            >
              {confirming?.kind === "purge"
                ? "Delete permanently"
                : `Close as ${confirming?.outcome ?? "done"}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
