import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { motion } from "motion/react";
import { Badge, Button } from "@cloudflare/kumo";
import {
  ArrowDownIcon,
  CaretDownIcon,
  CaretRightIcon,
  ClockIcon,
  PlayIcon,
} from "@phosphor-icons/react";
import {
  BaseMovedChip,
  CommittedChip,
  FolderLandedBadge,
  HotkeyBadge,
  IssueChip,
  PrChip,
  UncommittedChip,
} from "@/components/agentboard-bits";
import { QueueRepoChips } from "@/components/queue-repo-chips";
import { QueueRepoFilter } from "@/components/queue-repo-filter";
import {
  prForFolder,
  requestAgentboardNav,
  taskForFolder,
  type FolderData,
  type RepoData,
} from "@/lib/agentboard";
import { fmtAge, type PrItem, type TaskItem } from "@/lib/data";
import { errorMessage, NotInTauri } from "@/lib/errors";
import { LANES, rankMove, REASON_FACE, snoozeUntil, type SnoozePreset } from "@/lib/queue";
import { repoAccentStyles, repoRowStyle } from "@/lib/repo-identity";
import type { Lane, QueueItem, TaskQueue, WaitReason } from "@/lib/schemas/queue";
import { shortcutHint, useShortcuts } from "@/lib/shortcuts";
import { invoke } from "@/lib/tauri";
import { toast } from "@/lib/toast";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";

export const HERO_KICKER: Record<WaitReason, string> = {
  unblock: "an agent errored",
  answer: "an agent is waiting on you",
  review: "an agent finished — review it",
  fix_ci: "CI is failing",
  address_review: "changes requested",
  land: "ready to land",
  cleanup: "landed — clean it up",
};

const LANE_TITLE: Record<Lane, string> = {
  on_you: "On you",
  running: "Running",
  parked: "Parked",
  idle: "Idle",
  no_shell: "No shell",
};

export const FOLDED_BY_DEFAULT: Lane[] = ["parked", "idle", "no_shell"];

const SNOOZES: { preset: SnoozePreset; short: string; label: string }[] = [
  { preset: "1h", short: "1h", label: "for an hour" },
  { preset: "tomorrow", short: "Tomorrow", label: "until tomorrow 9:00" },
  { preset: "until_change", short: "Till it changes", label: "until it changes" },
];

async function report(r: Awaited<ReturnType<typeof invoke>>) {
  if (r.isErr() && !NotInTauri.is(r.error)) toast.error(errorMessage(r.error));
}

export async function snoozeQueueItem(item: QueueItem, preset: SnoozePreset): Promise<void> {
  if (!item.reason) return;
  uiAction("queue.snooze", "agentboard", preset);
  await report(
    await invoke<void>("queue_snooze", {
      folderDir: item.folderDir,
      reason: item.reason,
      untilMs: snoozeUntil(preset, Date.now()),
    }),
  );
}

export async function rerankQueueItem(
  items: readonly QueueItem[],
  item: QueueItem,
  direction: "up" | "down" | "top",
): Promise<void> {
  const to = rankMove(items, items.indexOf(item), direction);
  if (!to || item.taskId == null) return;
  uiAction("queue.reorder", "agentboard", direction);
  await report(await invoke<void>("queue_move", { id: item.taskId, to }));
}

async function unsnoozeItem(item: QueueItem) {
  uiAction("queue.unsnooze", "agentboard");
  await report(await invoke<void>("queue_unsnooze", { folderDir: item.folderDir }));
}

/** `queue-next` from any screen, terminals included: Agent Board opens the head in place. */
export function QueueNextShortcut() {
  const { openTab, activeTab } = useWorkspace();
  useShortcuts(
    useMemo(
      () => ({
        "queue-next": () => {
          openTab("agentboard");
          requestAgentboardNav({ kind: "queue-next" });
        },
      }),
      [openTab],
    ),
    activeTab,
  );
  return null;
}

/** The left rail: the tree's checkouts, roots included, as one queue — Next
 * up, then every lane. Rows only select — the checkout's terminals open beside it; nothing
 * here acts on an agent. */
export function QueueRail({
  queue,
  allItems,
  repoFilter,
  onRepoFilterChange,
  repoByFolder,
  folderByDir,
  prs,
  tasks,
  onOpenFiles,
  live,
  now,
  head,
  selectedId,
  folded,
  hotkeys,
  snoozeId,
  onSnoozeIdChange,
  onToggleLane,
  onSelect,
  onOpenHead,
  repos,
  newTaskRepoKey,
  onPickRepo,
  newTaskForm,
}: {
  /** Already narrowed to `repoFilter`. */
  queue: TaskQueue;
  /** The whole queue, for the filter's pills. */
  allItems: readonly QueueItem[];
  repoFilter: ReadonlySet<string>;
  onRepoFilterChange: (picked: ReadonlySet<string>) => void;
  /** Checkout dir → its repo, for the row's identity tag. */
  repoByFolder: ReadonlyMap<string, RepoData>;
  /** Checkout dir → its rail data, for the tree's git and link chips. */
  folderByDir: ReadonlyMap<string, FolderData>;
  prs: PrItem[];
  tasks: TaskItem[];
  onOpenFiles: (folderDir: string) => void;
  live: boolean;
  now: number;
  head: QueueItem | undefined;
  /** The ringed row's `folderDir`. */
  selectedId: string | null;
  folded: ReadonlySet<Lane>;
  /** Checkout dir → jump digit, only while the chord is held. */
  hotkeys: Map<string, number> | undefined;
  /** The checkout whose snooze menu is open. */
  snoozeId: string | null;
  onSnoozeIdChange: (id: string | null) => void;
  onToggleLane: (lane: Lane) => void;
  onSelect: (item: QueueItem) => void;
  /** The hero's Open — the mouse twin of `queue-next`. */
  onOpenHead: () => void;
  /** The header `+` — the mouse twin of `ab-new-task`. */
  /** Every tracked repo, one new-task chip each. */
  repos: readonly RepoData[];
  newTaskRepoKey: string | null;
  onPickRepo: (repo: RepoData) => void;
  /** The new-task form, open under the header. */
  newTaskForm?: ReactNode;
}) {
  const chipsFor = (item: QueueItem) => (
    <CheckoutChips
      folder={folderByDir.get(item.folderDir)}
      repo={repoByFolder.get(item.folderDir)}
      prs={prs}
      tasks={tasks}
      onOpenFiles={() => onOpenFiles(item.folderDir)}
    />
  );
  return (
    <div className="flex flex-col">
      <QueueRepoChips repos={repos} activeKey={newTaskRepoKey} onPick={onPickRepo} />
      {newTaskForm}
      <QueueRepoFilter
        repos={repos}
        items={allItems}
        repoByFolder={repoByFolder}
        picked={repoFilter}
        onChange={onRepoFilterChange}
      />
      {!live ? (
        <p className="px-3 py-8 text-center text-sm text-kumo-subtle">Not connected yet.</p>
      ) : queue.items.length === 0 && repoFilter.size > 0 ? (
        <p className="px-3 py-8 text-center text-sm text-kumo-subtle">
          Nothing queued in the picked repos.
        </p>
      ) : queue.items.length === 0 ? (
        <p className="px-3 py-8 text-center text-sm text-kumo-subtle">
          No checkouts yet — start a task from a repo above.
        </p>
      ) : (
        <>
          {head && (
            <Hero
              item={head}
              repo={repoByFolder.get(head.folderDir)}
              now={now}
              selected={head.folderDir === selectedId}
              chips={chipsFor(head)}
              onOpen={onOpenHead}
              onLater={() => void rerankQueueItem(queue.items, head, "down")}
              onSnooze={(preset) => void snoozeQueueItem(head, preset)}
            />
          )}
          {LANES.map((lane) => {
            const items = queue.items.filter((i) => i.lane === lane);
            if (items.length === 0) return null;
            const isFolded = folded.has(lane);
            return (
              <div key={lane}>
                <button
                  type="button"
                  onClick={() => onToggleLane(lane)}
                  aria-expanded={!isFolded}
                  data-testid="queue-lane"
                  className="flex w-full items-center gap-1 px-3 pt-3 pb-1 text-left text-xs font-medium tracking-wide text-kumo-subtle uppercase hover:text-kumo-default"
                >
                  {isFolded ? <CaretRightIcon size={12} /> : <CaretDownIcon size={12} />}
                  {LANE_TITLE[lane]} · {items.length}
                </button>
                {!isFolded &&
                  items.map((item) => {
                    const id = item.folderDir;
                    return (
                      <QueueRow
                        key={id}
                        item={item}
                        repo={repoByFolder.get(item.folderDir)}
                        now={now}
                        selected={id === selectedId}
                        chips={chipsFor(item)}
                        hotkey={hotkeys?.get(id)}
                        snoozeOpen={snoozeId === id}
                        onSnoozeOpenChange={(o) => onSnoozeIdChange(o ? id : null)}
                        onSelect={() => onSelect(item)}
                      />
                    );
                  })}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

function Hero({
  item,
  repo,
  now,
  selected,
  chips,
  onOpen,
  onLater,
  onSnooze,
}: {
  item: QueueItem;
  repo: RepoData | undefined;
  now: number;
  selected: boolean;
  chips: ReactNode;
  onOpen: () => void;
  onLater: () => void;
  onSnooze: (preset: SnoozePreset) => void;
}) {
  const look = repoLook(repo, item.repo);
  return (
    <motion.div
      key={item.folderDir}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      style={look.rowStyle}
      className={cn(
        "m-2 rounded-lg border border-l-4 border-kumo-brand/40 p-3",
        selected && "ring-1 ring-kumo-brand",
      )}
    >
      <div className="text-[11px] font-semibold tracking-wide text-kumo-brand uppercase">
        Next up{item.reason && ` · ${HERO_KICKER[item.reason]}`}
      </div>
      <RepoName look={look} className="mt-1 text-lg" />
      <div className="truncate text-base font-semibold text-kumo-default">{item.title}</div>
      <div className="truncate font-mono text-xs text-kumo-subtle">
        {[item.branch, item.sinceMs != null ? `waiting ${fmtAge(item.sinceMs, now)}` : null]
          .filter(Boolean)
          .join(" · ")}
      </div>
      <div className="mt-1">{chips}</div>
      {item.said && item.said !== item.title && (
        <div className="mt-2 line-clamp-2 rounded-md border-l-2 border-kumo-warning bg-kumo-tint px-2 py-1 text-xs">
          {item.said}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {!selected && (
          <Button size="xs" variant="primary" icon={<PlayIcon weight="fill" />} onClick={onOpen}>
            Open <span className="ml-1 opacity-70">{shortcutHint("queue-next")}</span>
          </Button>
        )}
        {item.reason && <SnoozeButtons onSnooze={onSnooze} />}
        {item.taskId != null && (
          <Button size="xs" variant="ghost" icon={<ArrowDownIcon />} onClick={onLater}>
            Later
          </Button>
        )}
      </div>
    </motion.div>
  );
}

/** The snooze presets as buttons, one click each. `z` lands focus on the first. */
export function SnoozeButtons({
  onSnooze,
  autoFocus = false,
  onDismiss,
}: {
  onSnooze: (preset: SnoozePreset) => void;
  autoFocus?: boolean;
  onDismiss?: () => void;
}) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (autoFocus) first.current?.focus();
  }, [autoFocus]);
  return (
    <div
      role="group"
      aria-label="Snooze"
      className="flex shrink-0 items-center gap-0.5"
      onKeyDown={(e) => {
        if (e.key === "Escape") onDismiss?.();
      }}
    >
      <ClockIcon aria-hidden className="mr-0.5 size-3.5 text-kumo-subtle" />
      {SNOOZES.map((s, i) => (
        <button
          key={s.preset}
          ref={i === 0 ? first : undefined}
          type="button"
          aria-label={`Snooze ${s.label}`}
          title={`Snooze ${s.label}`}
          onClick={() => onSnooze(s.preset)}
          className="rounded-md px-1.5 py-0.5 text-xs text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:outline-none"
        >
          {s.short}
        </button>
      ))}
    </div>
  );
}

type RepoLook = {
  name: string;
  textStyle: CSSProperties | undefined;
  rowStyle: CSSProperties | undefined;
};

/** Which repo a row is — the headspace you'd be switching into — worn by the
 * whole row in the repo's color. */
function repoLook(repo: RepoData | undefined, fallback: string): RepoLook {
  return {
    name: repo?.name ?? fallback,
    textStyle: repoAccentStyles(repo).iconStyle,
    rowStyle: repoRowStyle(repo),
  };
}

function RepoName({ look, className }: { look: RepoLook; className?: string }) {
  return (
    <div style={look.textStyle} className={cn("truncate leading-tight font-bold", className)}>
      {look.name}
    </div>
  );
}

/** The tree's git and link chips for a checkout — the same components, resolved
 * the same way, so a row reads alike on either rail. Nothing when all is clean. */
function CheckoutChips({
  folder,
  repo,
  prs,
  tasks,
  onOpenFiles,
}: {
  folder: FolderData | undefined;
  repo: RepoData | undefined;
  prs: PrItem[];
  tasks: TaskItem[];
  onOpenFiles: () => void;
}) {
  if (!folder || folder.dirMissing) return null;
  const pr = prForFolder(prs, repo?.originUrl, folder.branch);
  const task = folder.isWorktree ? taskForFolder(tasks, folder.dir) : undefined;
  return (
    <div className="flex shrink-0 items-center gap-1.5 empty:hidden">
      {pr && <PrChip pr={pr} stats={folder} />}
      {task?.issues.map((issue) => (
        <IssueChip key={`${issue.repo}#${issue.number}`} taskId={task.id} issue={issue} />
      ))}
      <FolderLandedBadge folder={folder} pr={pr} />
      <BaseMovedChip stats={folder} />
      <UncommittedChip stats={folder} onOpen={onOpenFiles} />
      <CommittedChip stats={folder} onOpen={onOpenFiles} />
    </div>
  );
}

function rowMeta(item: QueueItem, now: number): string {
  return [
    item.branch,
    item.ci.length > 0 ? item.ci.map((c) => c.workflow).join(", ") : null,
    item.runningAgents > 0
      ? `${item.runningAgents} agent${item.runningAgents === 1 ? "" : "s"} working`
      : null,
    item.snoozed
      ? item.snoozedUntilMs != null
        ? `snoozed ${fmtAge(now, item.snoozedUntilMs)}`
        : "snoozed until it changes"
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function QueueRow({
  item,
  repo,
  now,
  selected,
  chips,
  hotkey,
  snoozeOpen,
  onSnoozeOpenChange,
  onSelect,
}: {
  item: QueueItem;
  repo: RepoData | undefined;
  now: number;
  selected: boolean;
  /** Clickable, so a sibling of the row's button, never inside it. */
  chips: ReactNode;
  hotkey: number | undefined;
  snoozeOpen: boolean;
  onSnoozeOpenChange: (open: boolean) => void;
  onSelect: () => void;
}) {
  const face = item.reason ? REASON_FACE[item.reason] : null;
  const look = repoLook(repo, item.repo);
  return (
    <div
      data-focus-kind={item.pr ? "pr" : undefined}
      data-focus-id={item.pr ? `${item.pr.repo}#${item.pr.number}` : undefined}
      style={look.rowStyle}
      className={cn(
        "group border-t border-l-4 border-kumo-line px-3 py-1.5 text-sm",
        selected && "ring-2 ring-kumo-brand ring-inset",
        item.lane !== "on_you" && "text-kumo-subtle",
      )}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSelect}
          aria-current={selected ? "true" : undefined}
          data-testid="queue-row"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {/* A reserved column, so revealing the digits never reflows a row. */}
          {hotkey !== undefined ? <HotkeyBadge n={hotkey} /> : <span className="w-4 shrink-0" />}
          {face ? (
            <Badge variant={face.variant} className="w-20 shrink-0 justify-center">
              {face.label}
              {item.also.length > 0 && ` +${item.also.length}`}
            </Badge>
          ) : item.lane === "on_you" ? (
            <span className="w-20 shrink-0" />
          ) : null}
          {/* Repo and title share one line: two lines a row, so twenty fit a screen. */}
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span style={look.textStyle} className="max-w-[45%] shrink-0 truncate font-bold">
              {look.name}
            </span>
            <span className="truncate font-medium text-kumo-default">{item.title}</span>
          </span>
          {item.sinceMs != null && (
            <span className="shrink-0 font-mono text-xs text-kumo-subtle tabular-nums">
              {fmtAge(item.sinceMs, now)}
            </span>
          )}
        </button>
        {item.snoozed && (
          <Button size="xs" variant="ghost" onClick={() => void unsnoozeItem(item)}>
            Wake
          </Button>
        )}
        {/* Only on the row you're on or over, so the queue still reads as titles. */}
        {item.reason && !item.snoozed && (
          <div
            className={cn(
              "shrink-0",
              selected || snoozeOpen ? "flex" : "hidden group-focus-within:flex group-hover:flex",
            )}
          >
            <SnoozeButtons
              autoFocus={snoozeOpen}
              onDismiss={() => onSnoozeOpenChange(false)}
              onSnooze={(preset) => {
                onSnoozeOpenChange(false);
                void snoozeQueueItem(item, preset);
              }}
            />
          </div>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2 pl-6">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-kumo-subtle">
          {rowMeta(item, now)}
        </span>
        {chips}
      </div>
    </div>
  );
}

/** Next up changed while you were busy — said here, never by taking focus. */
export function NextUpBanner({
  item,
  onOpen,
  onDismiss,
}: {
  item: QueueItem;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      role="status"
      className="flex shrink-0 items-center gap-2 border-b border-kumo-brand/40 bg-kumo-brand/10 px-3 py-1.5 text-sm"
    >
      <span className="text-xs font-semibold tracking-wide text-kumo-brand uppercase">Next up</span>
      <span className="min-w-0 truncate font-medium">{item.title}</span>
      {item.reason && (
        <span className="shrink-0 text-xs text-kumo-subtle">{HERO_KICKER[item.reason]}</span>
      )}
      <div className="ml-auto flex shrink-0 gap-1">
        <Button size="xs" variant="primary" onClick={onOpen}>
          Open <span className="ml-1 opacity-70">{shortcutHint("queue-next")}</span>
        </Button>
        <Button size="xs" variant="ghost" onClick={onDismiss}>
          Not now
        </Button>
      </div>
    </motion.div>
  );
}
