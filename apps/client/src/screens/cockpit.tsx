import { useEffect, useMemo, useRef, useState } from "react";
import { Banner, Button, DropdownMenu, Tabs, Tooltip } from "@cloudflare/kumo";
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  CalendarDotsIcon,
  DotsThreeIcon,
  EyeSlashIcon,
  GearIcon,
  GitBranchIcon,
  GitForkIcon,
  GitPullRequestIcon,
  LinkIcon,
  ListChecksIcon,
  PaperPlaneTiltIcon,
  RecordIcon,
  VideoCameraIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { toast } from "@/lib/toast";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  COUNTDOWN_SECONDS_THRESHOLD,
  currentOrNextEvent,
  eventIsLive,
  fmtAge,
  fmtClock,
  fmtCountdown,
  isItemDismissed,
  type IssueItem,
  type PrItem,
  storeCollectNow,
  storeDismissalsClear,
  storeItemDismiss,
  useStoreSnapshot,
} from "@/lib/data";
import {
  COCKPIT_REPO_FILTER_KEY,
  cockpitRepos,
  filterByRepo,
  loadRepoFilter,
} from "@/lib/cockpit-filter";
import { dataRefreshedAt } from "@/lib/collector-health";
import { useAgentboardState } from "@/lib/agentboard";
import { useNow, useNowInterval } from "@/lib/now";
import { NotInTauri, errorMessage } from "@/lib/errors";
import { invoke } from "@/lib/tauri";
import { openExternalUrl } from "@/lib/open-url";
import { useWorkspace } from "@/lib/workspace";
import { useFocusTarget } from "@/lib/focus-target";
import { uiAction } from "@/lib/ui-action";
import { Empty, IssueRow, Panel, PrRow } from "@/components/store-bits";
import { prNeedsYou, prRank } from "@/lib/pr-tone";
import { CockpitCiHealth } from "@/components/cockpit-ci-health";
import { CockpitWorkQueue } from "@/components/cockpit-work-queue";
import { buildWorkQueue } from "@/lib/cockpit-queue";

/** A tracked checkout a Cockpit issue can be dispatched into. */
type TaskTarget = { dir: string; branch: string; name: string };

/** Folds the ssh/https/scp forms enough to compare the trailing `owner/name`.
 * Only filters the menu — the Rust guard (`validate_task_for_repo`) re-checks
 * authoritatively before any dispatch. */
function repoMatches(originUrl: string | null | undefined, repo: string): boolean {
  if (!originUrl) return false;
  const norm = originUrl
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/:/g, "/");
  return norm.endsWith(`/${repo.toLowerCase()}`);
}

/** Cockpit — the day home and the head of the loop: the work queue of agents and
 * tasks waiting on you, time until the next meeting, the PRs that need you, the
 * issue queue. Read-only over the store snapshot and Agentboard state. */
export function CockpitScreen() {
  const { snapshot, live } = useStoreSnapshot();
  const agentState = useAgentboardState();
  const { openSettingsTab } = useWorkspace();
  const now = useNow();
  // Deep-link focus: a "needs you" popover row scrolls its PR into view here.
  const focusRef = useFocusTarget<HTMLDivElement>("cockpit");

  // The refresh button re-enables on a newer collector run or a safety timeout,
  // so it never sticks disabled.
  const refreshedAt = dataRefreshedAt(snapshot.runs, now);
  const [refreshing, setRefreshing] = useState(false);
  const refreshBaseline = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!refreshing) return;
    const landed =
      refreshedAt !== undefined &&
      (refreshBaseline.current === undefined || refreshedAt > refreshBaseline.current);
    if (landed) {
      setRefreshing(false);
      return;
    }
    const t = setTimeout(() => setRefreshing(false), 30_000);
    return () => clearTimeout(t);
  }, [refreshing, refreshedAt]);

  async function refresh() {
    refreshBaseline.current = refreshedAt;
    setRefreshing(true);
    const started = await storeCollectNow();
    if (started.isErr() && !NotInTauri.is(started.error)) toast.error(started.error.message);
    // `false` = overlap, failure, or browser dev — nothing new to wait on.
    if (!started.unwrapOr(false)) setRefreshing(false);
  }

  // Empty when no matching repo is tracked, which disables assign/branch.
  const tasksFor = (repo: string): TaskTarget[] =>
    agentState.repos
      .filter((r) => repoMatches(r.originUrl, repo))
      .flatMap((r) => r.folders.map((f) => ({ dir: f.dir, branch: f.branch, name: f.name })));

  const nextEvent = currentOrNextEvent(snapshot.events, now);
  const meetingLive = nextEvent ? eventIsLive(nextEvent, now) : false;
  const msUntilStart = nextEvent && !meetingLive ? nextEvent.startTs - now : Infinity;
  const soon = nextEvent ? !meetingLive && nextEvent.startTs - now < 15 * 60_000 : false;
  // In the final approach the countdown shows m:ss, so the shared clock has to
  // tick at 1s to match; back off once we pass it.
  useNowInterval(msUntilStart > 0 && msUntilStart < COUNTDOWN_SECONDS_THRESHOLD ? 1000 : undefined);
  const highlight = meetingLive || soon;
  const later = snapshot.events
    .filter((e) => e.startTs > now && e.id !== nextEvent?.id)
    .toSorted((a, b) => a.startTs - b.startTs);
  // The rest hide behind "+N more" so a busy day never floods the strip.
  const [laterExpanded, setLaterExpanded] = useState(false);
  const LATER_INLINE = 4;
  const shownLater = laterExpanded ? later : later.slice(0, LATER_INLINE);
  const hiddenLaterCount = later.length - shownLater.length;

  // Chips narrow both panels, never the strip gauges. The selection survives a
  // relaunch, written through on click rather than from an effect so a rendered
  // fallback (a repo collected away) never overwrites a real choice.
  const [repoFilter, setRepoFilter] = useState<string | null>(() =>
    loadRepoFilter(localStorage.getItem(COCKPIT_REPO_FILTER_KEY)),
  );
  function selectRepo(repo: string | null) {
    uiAction("cockpit.repo_filter", "cockpit", repo ?? "all");
    setRepoFilter(repo);
    if (repo === null) localStorage.removeItem(COCKPIT_REPO_FILTER_KEY);
    else localStorage.setItem(COCKPIT_REPO_FILTER_KEY, repo);
  }
  // Merged PRs live in the snapshot briefly (for the rail chip), but Cockpit's
  // queue is open work — exclude them.
  const openPrs = useMemo(
    () => snapshot.prs.filter((p) => p.state === "open" && !isItemDismissed(p)),
    [snapshot.prs],
  );
  const openIssues = useMemo(
    () => snapshot.issues.filter((i) => !isItemDismissed(i)),
    [snapshot.issues],
  );
  const queue = useMemo(
    () => buildWorkQueue(agentState.repos, snapshot.prs),
    [agentState.repos, snapshot.prs],
  );
  const repoList = cockpitRepos([...queue, ...openPrs], openIssues, snapshot.ciRuns);
  const activeRepo = repoFilter !== null && repoList.includes(repoFilter) ? repoFilter : null;
  const visibleQueue = filterByRepo(queue, activeRepo);
  const visiblePrs = filterByRepo(openPrs, activeRepo);
  const visibleIssues = filterByRepo(openIssues, activeRepo);

  const needsYouPrs = openPrs.filter(prNeedsYou);
  const visibleNeedsYou = visiblePrs.filter(prNeedsYou);

  const dismissedCount =
    snapshot.prs.filter(isItemDismissed).length + snapshot.issues.filter(isItemDismissed).length;
  const [clearingDismissals, setClearingDismissals] = useState(false);
  async function clearDismissals() {
    uiAction("cockpit.dismissals_clear", "cockpit");
    setClearingDismissals(true);
    const cleared = await storeDismissalsClear();
    if (cleared.isOk()) {
      const n = cleared.value;
      toast.success(n === 1 ? "1 item restored" : `${n} items restored`);
    } else if (!NotInTauri.is(cleared.error)) {
      toast.error(cleared.error.message);
    }
    setClearingDismissals(false);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Next-meeting strip */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-8 gap-y-2 border-b px-5 py-4">
        <div className="flex items-center gap-3">
          <CalendarDotsIcon
            size={20}
            className={highlight ? "text-amber-500" : "text-kumo-subtle"}
          />
          {nextEvent ? (
            <div className="flex items-center gap-3">
              <span
                className={cn(
                  "font-mono text-3xl font-semibold tabular-nums",
                  highlight ? "text-amber-500" : "text-foreground",
                )}
              >
                {meetingLive ? "Now" : fmtCountdown(nextEvent.startTs - now)}
              </span>
              <div className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">{nextEvent.title}</span>
                <span className="text-xs text-kumo-subtle">
                  {meetingLive && nextEvent.endTs !== undefined
                    ? `until ${fmtClock(nextEvent.endTs)}`
                    : fmtClock(nextEvent.startTs)}
                  {nextEvent.location ? ` · ${nextEvent.location}` : ""}
                </span>
              </div>
              {nextEvent.joinUrl ? (
                <Button
                  size="sm"
                  variant={meetingLive ? "primary" : "secondary"}
                  icon={<VideoCameraIcon />}
                  onClick={() => {
                    uiAction("cockpit.meeting_join", "cockpit");
                    if (nextEvent.joinUrl) void openExternalUrl(nextEvent.joinUrl);
                  }}
                >
                  Join
                </Button>
              ) : null}
            </div>
          ) : (
            <span className="text-sm text-kumo-subtle">No more meetings today.</span>
          )}
        </div>

        {later.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-kumo-subtle">
            <span className="uppercase tracking-wide">Then</span>
            {shownLater.map((e) => (
              <span key={e.id} className="rounded-md bg-kumo-recessed px-2 py-0.5">
                {e.title} · {fmtClock(e.startTs)}
              </span>
            ))}
            {hiddenLaterCount > 0 ? (
              <button
                type="button"
                onClick={() => {
                  uiAction("cockpit.later_toggle", "cockpit", "more");
                  setLaterExpanded(true);
                }}
                className="rounded-md px-2 py-0.5 font-medium text-foreground hover:bg-accent"
              >
                +{hiddenLaterCount} more
              </button>
            ) : laterExpanded && later.length > LATER_INLINE ? (
              <button
                type="button"
                onClick={() => {
                  uiAction("cockpit.later_toggle", "cockpit", "less");
                  setLaterExpanded(false);
                }}
                className="rounded-md px-2 py-0.5 font-medium text-foreground hover:bg-accent"
              >
                Show less
              </button>
            ) : null}
          </div>
        )}

        <div className="ml-auto flex items-center gap-4 text-xs text-kumo-subtle">
          <Tooltip
            content="Refresh pull requests and issues now"
            render={
              <Button
                size="sm"
                variant="ghost"
                loading={refreshing}
                icon={<ArrowClockwiseIcon />}
                onClick={() => {
                  uiAction("cockpit.refresh", "cockpit");
                  void refresh();
                }}
                aria-label="Refresh PRs and issues"
              >
                <span className="tabular-nums">
                  {refreshing
                    ? "Refreshing…"
                    : refreshedAt !== undefined
                      ? `Refreshed ${fmtAge(refreshedAt, now)}`
                      : "Refresh"}
                </span>
              </Button>
            }
          />
          <Gauge n={queue.length} label="In queue" tone={queue.length ? "warn" : "muted"} />
          <Gauge
            n={needsYouPrs.length}
            label="PRs need you"
            tone={needsYouPrs.length ? "warn" : "muted"}
          />
          <Gauge n={openIssues.length} label="Issues" tone="muted" />
          <Gauge n={repoList.length} label="Repos" tone="muted" />
          {dismissedCount > 0 && (
            <Tooltip
              content="Bring back every dismissed PR and issue"
              render={
                <Button
                  size="sm"
                  variant="ghost"
                  loading={clearingDismissals}
                  icon={<EyeSlashIcon />}
                  onClick={() => void clearDismissals()}
                  aria-label="Clear all dismissals"
                >
                  <span className="tabular-nums">{dismissedCount} dismissed</span>
                </Button>
              }
            />
          )}
        </div>
      </div>

      {/* Repo filter chips — narrow both panels to one repo (only worth showing
          when there's more than one to choose between). */}
      {repoList.length > 1 && (
        <div className="flex shrink-0 items-center overflow-x-auto border-b px-5 py-2">
          <Tabs
            size="sm"
            variant="segmented"
            value={activeRepo ?? ALL_REPOS}
            onValueChange={(v) => selectRepo(v === ALL_REPOS ? null : v)}
            tabs={[
              { value: ALL_REPOS, label: "All repos" },
              ...repoList.map((repo) => ({
                value: repo,
                label: <span className="font-mono">{repo}</span>,
              })),
            ]}
          />
        </div>
      )}

      {!live && (
        <Banner
          variant="alert"
          size="sm"
          className="shrink-0 rounded-none border-x-0 border-t-0"
          icon={<WarningCircleIcon />}
          title="Not connected to the store"
          description="Open this window in the Towles Tool app to see live PRs, issues, and events."
        />
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div ref={focusRef} className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-2">
          <CockpitWorkQueue queue={visibleQueue} now={now} live={live} />
          <CockpitCiHealth runs={snapshot.ciRuns} repo={activeRepo} now={now} live={live} />
          {/* Pull requests */}
          <Panel
            title="Pull requests"
            note={`${visibleNeedsYou.length} need you`}
            icon={<GitPullRequestIcon size={16} />}
          >
            {visiblePrs.length === 0 ? (
              live ? (
                <SetupEmpty
                  message="No open PRs across your repos."
                  filter="prs"
                  detail="prs"
                  openSettingsTab={openSettingsTab}
                />
              ) : (
                <Empty>Not connected yet.</Empty>
              )
            ) : (
              visiblePrs
                .slice()
                .toSorted((a, b) => prRank(b) - prRank(a) || b.updatedTs - a.updatedTs)
                .map((pr) => (
                  <PrRow
                    key={`${pr.repo}#${pr.number}`}
                    pr={pr}
                    now={now}
                    actions={<PrActions pr={pr} />}
                  />
                ))
            )}
          </Panel>

          {/* Issue queue */}
          <Panel
            title="Issue queue"
            note={`${visibleIssues.length} open`}
            icon={<RecordIcon size={16} />}
          >
            {visibleIssues.length === 0 ? (
              live ? (
                <SetupEmpty
                  message="No issues assigned to you."
                  filter="issue"
                  detail="issues"
                  openSettingsTab={openSettingsTab}
                />
              ) : (
                <Empty>Not connected yet.</Empty>
              )
            ) : (
              visibleIssues
                .slice()
                .toSorted((a, b) => b.updatedTs - a.updatedTs)
                .map((issue) => (
                  <IssueRow
                    key={`${issue.repo}#${issue.number}`}
                    issue={issue}
                    now={now}
                    actions={<IssueActions issue={issue} tasks={tasksFor(issue.repo)} />}
                  />
                ))
            )}
          </Panel>
        </div>
      </ScrollArea>
    </div>
  );
}

/** Run an issue-dispatch command; the Rust side's message is authoritative. */
async function runIssueCommand(cmd: string, args: Record<string, unknown>) {
  uiAction("cockpit.issue_dispatch", "cockpit", cmd);
  (await invoke<string>(cmd, args)).match({
    ok: (msg) => toast.success(msg),
    err: (e) => toast.error(e.message),
  });
}

/** Copy text to the clipboard, naming what was copied in the confirmation. */
async function copyToClipboard(text: string, what: string) {
  uiAction("cockpit.copy", "cockpit", what);
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`Copied ${what}`);
  } catch (e) {
    toast.error(errorMessage(e));
  }
}

/** Dismiss one issue/PR. The snapshot re-emits from Rust, so nothing optimistic. */
async function dismissItem(kind: "issue" | "pr", repo: string, number: number, updatedTs: number) {
  uiAction("cockpit.item_dismiss", "cockpit", kind);
  const result = await storeItemDismiss(kind, repo, number, updatedTs);
  if (result.isErr() && !NotInTauri.is(result.error)) toast.error(result.error.message);
}

/** Per-issue action menu: open in the browser, or dispatch into a tracked task
 * checkout. The Rust command re-runs the clean-tree guard and toasts. */
function IssueActions({ issue, tasks }: { issue: IssueItem; tasks: TaskTarget[] }) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button
            size="sm"
            shape="square"
            variant="ghost"
            className="shrink-0 opacity-0 group-hover:opacity-100 data-[popup-open]:opacity-100"
            aria-label="Issue actions"
            icon={<DotsThreeIcon size={16} weight="bold" />}
          />
        }
      />
      <DropdownMenu.Content align="end" className="w-52">
        <DropdownMenu.Item
          onClick={() => {
            uiAction("cockpit.open_external", "cockpit", "issue");
            void openExternalUrl(issue.url);
          }}
          icon={ArrowSquareOutIcon}
        >
          Open in browser
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <TaskSubmenu
          icon={PaperPlaneTiltIcon}
          label="Assign to task"
          tasks={tasks}
          onPick={(task) =>
            void runIssueCommand("cockpit_assign_issue", {
              repo: issue.repo,
              number: issue.number,
              taskDir: task.dir,
            })
          }
        />
        <TaskSubmenu
          icon={GitForkIcon}
          label="Create branch"
          tasks={tasks}
          onPick={(task) =>
            void runIssueCommand("cockpit_create_issue_branch", {
              repo: issue.repo,
              number: issue.number,
              title: issue.title,
              taskDir: task.dir,
            })
          }
        />
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          onClick={() => void dismissItem("issue", issue.repo, issue.number, issue.updatedTs)}
          icon={EyeSlashIcon}
        >
          Dismiss
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

/** Per-PR action menu. Navigation and clipboard only — no merge/review/approve:
 * PR state is reported here, never acted on (that happens on GitHub). */
function PrActions({ pr }: { pr: PrItem }) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button
            size="sm"
            shape="square"
            variant="ghost"
            className="shrink-0 opacity-0 group-hover:opacity-100 data-[popup-open]:opacity-100"
            aria-label="PR actions"
            icon={<DotsThreeIcon size={16} weight="bold" />}
          />
        }
      />
      <DropdownMenu.Content align="end" className="w-52">
        <DropdownMenu.Item
          onClick={() => {
            uiAction("cockpit.open_external", "cockpit", "pr");
            void openExternalUrl(pr.url);
          }}
          icon={ArrowSquareOutIcon}
        >
          Open in browser
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onClick={() => {
            uiAction("cockpit.open_external", "cockpit", "pr_checks");
            void openExternalUrl(`${pr.url}/checks`);
          }}
          icon={ListChecksIcon}
        >
          Open checks
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          onClick={() => void copyToClipboard(pr.branch, "branch name")}
          icon={GitBranchIcon}
        >
          Copy branch name
        </DropdownMenu.Item>
        <DropdownMenu.Item onClick={() => void copyToClipboard(pr.url, "PR URL")} icon={LinkIcon}>
          Copy PR URL
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          onClick={() => void dismissItem("pr", pr.repo, pr.number, pr.updatedTs)}
          icon={EyeSlashIcon}
        >
          Dismiss
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

/** Candidate task checkouts, or a disabled hint when the repo isn't tracked. */
function TaskSubmenu({
  icon,
  label,
  tasks,
  onPick,
}: {
  icon: React.ComponentProps<typeof DropdownMenu.SubTrigger>["icon"];
  label: string;
  tasks: TaskTarget[];
  onPick: (task: TaskTarget) => void;
}) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger icon={icon}>{label}</DropdownMenu.SubTrigger>
      <DropdownMenu.SubContent className="w-64">
        {tasks.length === 0 ? (
          <DropdownMenu.Item disabled>No matching task checkout</DropdownMenu.Item>
        ) : (
          tasks.map((task) => (
            <DropdownMenu.Item key={task.dir} onClick={() => onPick(task)}>
              <div className="flex min-w-0 flex-col">
                <span className="truncate">{task.name}</span>
                <span className="truncate font-mono text-xs text-kumo-subtle">{task.branch}</span>
              </div>
            </DropdownMenu.Item>
          ))
        )}
      </DropdownMenu.SubContent>
    </DropdownMenu.Sub>
  );
}

/** Empty-panel body routing into Settings' Collectors tab — an empty panel is
 * usually an unconfigured collector, not a dead end. `filter` seeds its search. */
function SetupEmpty({
  message,
  filter,
  detail,
  openSettingsTab,
}: {
  message: string;
  filter: string;
  detail: string;
  openSettingsTab: (target?: { tab: string; filter?: string }) => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
      <p className="text-sm text-kumo-subtle">{message}</p>
      <Button
        size="sm"
        variant="secondary"
        icon={<GearIcon />}
        onClick={() => {
          uiAction("cockpit.setup_collector", "cockpit", detail);
          openSettingsTab({ tab: "collectors", filter });
        }}
      >
        Set up in Settings
      </Button>
    </div>
  );
}

/** Tab value for the unfiltered view — no repo is named this. */
const ALL_REPOS = "__all__";

function Gauge({ n, label, tone }: { n: number; label: string; tone: "warn" | "muted" }) {
  return (
    <div className="flex flex-col items-center">
      <span
        className={cn(
          "font-mono text-xl font-semibold tabular-nums",
          tone === "warn" && n > 0 ? "text-amber-500" : "text-kumo-default",
        )}
      >
        {n}
      </span>
      <span className="text-xs text-kumo-subtle">{label}</span>
    </div>
  );
}
