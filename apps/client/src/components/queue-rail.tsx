import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@cloudflare/kumo";
import { CaretDownIcon, CaretRightIcon, ClockIcon } from "@phosphor-icons/react";
import {
  BaseMovedChip,
  CommittedChip,
  UncommittedChip,
} from "@/components/agentboard-bits/diff-chips";
import { FolderLandedBadge } from "@/components/agentboard-bits/landed-badges";
import { IssueChip, PrChip } from "@/components/agentboard-bits/pr-issue-chips";
import { HotkeyBadge } from "@/components/agentboard-bits/primitives";
import { QueueRepoBar } from "@/components/queue-repo-bar";
import { isHomeRepo, prForFolder, taskForFolder } from "@/lib/agentboard/folder";
import { branchRedundant } from "@/lib/agentboard/folder-name";
import { requestAgentboardNav } from "@/lib/agentboard/requests";
import type { FolderData, RepoData } from "@/lib/agentboard/types";
import { fmtAge, type PrItem, type TaskItem } from "@/lib/data";
import { errorMessage, NotInTauri } from "@/lib/errors";
import {
  LANES,
  rankMove,
  reasonChip,
  REASON_TONE,
  snoozePresets,
  snoozeUntil,
  type SnoozePreset,
  type Tone,
} from "@/lib/queue";
import { repoAccentStyles } from "@/lib/repo-identity";
import type { Lane, QueueItem, TaskQueue } from "@/lib/schemas/queue";
import { useShortcuts } from "@/lib/shortcuts";
import { invoke } from "@/lib/tauri";
import { toast } from "@/lib/toast";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";

const LANE_TITLE: Record<Lane, string> = {
  on_you: "On you",
  idle: "Idle",
  running: "Running",
  parked: "Parked",
  no_shell: "Not open",
};

export const FOLDED_BY_DEFAULT: Lane[] = ["parked", "no_shell"];

/** Soft by design — the queue is somewhere you go, not something that calls
 * you. A row changing lane fades out where it was and fades in where it went
 * (it is keyed by lane too) rather than sliding across the list for the eye to
 * chase, and the rows around it reflow with its height. The arrival waits out
 * the departure, so the same row is never on screen twice; no `layout`, which
 * re-measured on every tick and slid rows against the height change. */
const queueRowMotion = {
  initial: { opacity: 0, height: 0 },
  animate: {
    opacity: 1,
    height: "auto",
    transition: { duration: 0.35, delay: 0.25, ease: "easeInOut" },
  },
  exit: { opacity: 0, height: 0, transition: { duration: 0.25, ease: "easeInOut" } },
  style: { overflow: "hidden" },
} as const;

/** A wait reason's word, tinted rather than filled: it says what kind of wait
 * this is, at the volume of the rest of the row. */
const TONE_CLASS: Record<Tone, string> = {
  red: "bg-danger/10 text-danger",
  orange: "bg-warn/10 text-warn",
  blue: "bg-info/10 text-info",
  green: "bg-ok/10 text-ok",
  neutral: "bg-kumo-tint text-kumo-subtle",
};

const SNOOZES: Record<SnoozePreset, { short: string; label: string }> = {
  "1h": { short: "1h", label: "for an hour" },
  tomorrow: { short: "Tomorrow", label: "until tomorrow 9:00" },
  until_change: { short: "Till it changes", label: "until it changes" },
  until_ci: { short: "Till CI's done", label: "until CI finishes" },
};

async function report(r: Awaited<ReturnType<typeof invoke>>) {
  if (r.isErr() && !NotInTauri.is(r.error)) toast.error(errorMessage(r.error));
}

async function snoozeQueueItem(item: QueueItem, preset: SnoozePreset): Promise<void> {
  if (!item.reason) return;
  uiAction("queue.snooze", "agentboard", preset);
  await report(
    await invoke<void>("queue_snooze", {
      folderDir: item.folderDir,
      reason: item.reason,
      untilMs: snoozeUntil(preset, Date.now()),
      untilCi: preset === "until_ci",
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
  selectedId,
  folded,
  hotkeys,
  snoozeId,
  onSnoozeIdChange,
  onToggleLane,
  onSelect,
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
  /** Every tracked repo, one pill each. */
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
      <QueueRepoBar
        // `~` is no repo: nothing to start a task in, or to reorder.
        repos={repos.filter((r) => !isHomeRepo(r))}
        items={allItems}
        repoByFolder={repoByFolder}
        picked={repoFilter}
        onFilterChange={onRepoFilterChange}
        activeKey={newTaskRepoKey}
        onPick={onPickRepo}
      />
      {newTaskForm}
      {!live ? (
        <p className="px-3 py-8 text-center text-sm text-kumo-subtle">Not connected yet.</p>
      ) : queue.items.length === 0 && repoFilter.size > 0 ? (
        <p className="px-3 py-8 text-center text-sm text-kumo-subtle">
          Nothing queued in the picked repos.
        </p>
      ) : queue.items.length === 0 ? (
        <p className="px-3 py-8 text-center text-sm text-kumo-subtle">
          No checkouts yet — start a task with a repo's + above.
        </p>
      ) : (
        // One flat list, headers and rows alike, so the rows around a change
        // ease into place together.
        <AnimatePresence initial={false}>
          {LANES.flatMap((lane) => {
            const items = queue.items.filter((i) => i.lane === lane);
            if (items.length === 0) return [];
            const isFolded = folded.has(lane);
            const header = (
              <motion.div key={`lane:${lane}`} {...queueRowMotion}>
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
              </motion.div>
            );
            if (isFolded) return [header];
            return [
              header,
              ...items.map((item) => {
                const id = item.folderDir;
                return (
                  <motion.div key={`${lane}:${id}`} {...queueRowMotion}>
                    <QueueRow
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
                  </motion.div>
                );
              }),
            ];
          })}
        </AnimatePresence>
      )}
    </div>
  );
}

/** The snooze presets as buttons, one click each. `z` lands focus on the first. */
function SnoozeButtons({
  presets,
  onSnooze,
  autoFocus = false,
  onDismiss,
}: {
  presets: SnoozePreset[];
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
      {presets.map((preset, i) => (
        <button
          key={preset}
          ref={i === 0 ? first : undefined}
          type="button"
          aria-label={`Snooze ${SNOOZES[preset].label}`}
          title={`Snooze ${SNOOZES[preset].label}`}
          onClick={() => onSnooze(preset)}
          className="rounded-md px-1.5 py-0.5 text-xs text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:outline-none"
        >
          {SNOOZES[preset].short}
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

/** Which repo a row is — the headspace you'd be switching into — on its name,
 * left edge and a 6% wash, the tree's repo-header treatment, so the ring and
 * the badges stay what the eye lands on. */
function repoLook(repo: RepoData | undefined, fallback: string): RepoLook {
  const accent = repoAccentStyles(repo);
  return {
    name: repo?.name ?? fallback,
    textStyle: accent.iconStyle,
    rowStyle: accent.edgeStyle && { ...accent.edgeStyle, ...accent.surfaceStyle },
  };
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
    branchRedundant(item.title, item.branch) ? null : item.branch,
    item.ci.length > 0 ? item.ci.map((c) => c.workflow).join(", ") : null,
    // Under Running, one agent working is what the lane already says.
    item.runningAgents > (item.lane === "running" ? 1 : 0)
      ? `${item.runningAgents} agent${item.runningAgents === 1 ? "" : "s"} working`
      : null,
    !item.snoozed
      ? null
      : item.snoozedUntilCi
        ? "snoozed until CI finishes"
        : item.snoozedUntilMs != null
          ? `snoozed ${fmtAge(now, item.snoozedUntilMs)}`
          : "snoozed until it changes",
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
  const chip = reasonChip(item, now);
  const look = repoLook(repo, item.repo);
  const meta = rowMeta(item, now);
  return (
    <div
      data-focus-kind={item.pr ? "pr" : undefined}
      data-focus-id={item.pr ? `${item.pr.repo}#${item.pr.number}` : undefined}
      style={look.rowStyle}
      className={cn(
        "group border-t border-l-4 border-kumo-line px-3 py-1.5 text-sm transition-colors duration-1000",
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
          {item.reason ? (
            <span
              data-testid="queue-reason"
              className={cn(
                "w-32 shrink-0 truncate rounded px-1.5 py-px text-center text-xs font-medium transition-colors duration-1000",
                TONE_CLASS[REASON_TONE[item.reason]],
              )}
            >
              {chip}
              {item.also.length > 0 && ` +${item.also.length}`}
            </span>
          ) : item.lane === "on_you" ? (
            <span className="w-32 shrink-0" />
          ) : null}
          {/* Repo and title share one line: two lines a row, so twenty fit a screen.
              With no meta to show, the title may take the meta's line instead. */}
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span style={look.textStyle} className="max-w-[45%] shrink-0 truncate font-bold">
              {look.name}
            </span>
            <span
              className={cn(
                "min-w-0 font-medium text-kumo-default",
                meta ? "truncate" : "line-clamp-2 break-words",
              )}
            >
              {item.title}
            </span>
          </span>
          {/* Off On you, the agent's state is a fact, so bare type, never a box. */}
          {!item.reason && chip && (
            <span className="shrink-0 font-mono text-xs text-kumo-subtle tabular-nums">{chip}</span>
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
              presets={snoozePresets(item)}
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
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-kumo-subtle">{meta}</span>
        {chips}
      </div>
    </div>
  );
}
