import { useMemo, type ReactNode } from "react";
import { motion } from "motion/react";
import { Badge, Button, DropdownMenu } from "@cloudflare/kumo";
import {
  ArrowDownIcon,
  CaretDownIcon,
  CaretRightIcon,
  ClockIcon,
  PlayIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { HotkeyBadge } from "@/components/agentboard-bits";
import { Hint } from "@/components/hint";
import { requestAgentboardNav } from "@/lib/agentboard";
import { fmtAge } from "@/lib/data";
import { errorMessage, NotInTauri } from "@/lib/errors";
import { keyId, LANES, rankMove, REASON_FACE, snoozeUntil, type SnoozePreset } from "@/lib/queue";
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
};

export const FOLDED_BY_DEFAULT: Lane[] = ["parked", "idle"];

const SNOOZES: { preset: SnoozePreset; label: string }[] = [
  { preset: "1h", label: "For an hour" },
  { preset: "tomorrow", label: "Until tomorrow 9:00" },
  { preset: "until_change", label: "Until it changes" },
];

async function report(r: Awaited<ReturnType<typeof invoke>>) {
  if (r.isErr() && !NotInTauri.is(r.error)) toast.error(errorMessage(r.error));
}

export async function snoozeQueueItem(item: QueueItem, preset: SnoozePreset): Promise<void> {
  if (!item.reason) return;
  uiAction("queue.snooze", "cockpit", `${item.key.kind}:${preset}`);
  await report(
    await invoke<void>("queue_snooze", {
      key: item.key,
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
  if (!to || item.key.kind !== "task") return;
  uiAction("queue.reorder", "cockpit", direction);
  await report(await invoke<void>("queue_move", { id: item.key.id, to }));
}

async function unsnoozeItem(item: QueueItem) {
  uiAction("queue.unsnooze", "cockpit", item.key.kind);
  await report(await invoke<void>("queue_unsnooze", { key: item.key }));
}

async function fileItem(item: QueueItem) {
  if (item.key.kind !== "unfiled") return;
  uiAction("queue.file", "cockpit");
  await report(await invoke<number>("queue_file_unfiled", { folderDir: item.key.folderDir }));
}

/** `queue-next` from any screen, terminals included: Cockpit opens the head in place. */
export function QueueNextShortcut() {
  const { openTab, activeTab } = useWorkspace();
  useShortcuts(
    useMemo(
      () => ({
        "queue-next": () => {
          openTab("cockpit");
          requestAgentboardNav({ kind: "queue-next" });
        },
      }),
      [openTab],
    ),
    activeTab,
  );
  return null;
}

/** The left rail: Agent Board's checkouts as one queue — Next up, then every
 * lane. Rows only select — the checkout's terminals open beside it; nothing
 * here acts on an agent. */
export function CockpitRail({
  queue,
  live,
  now,
  head,
  selectedKey,
  folded,
  hotkeys,
  snoozeKey,
  onSnoozeKeyChange,
  onToggleLane,
  onSelect,
  onOpenHead,
  onNewTask,
  newTaskForm,
}: {
  queue: TaskQueue;
  live: boolean;
  now: number;
  head: QueueItem | undefined;
  selectedKey: string | null;
  folded: ReadonlySet<Lane>;
  /** Row key → jump digit, only while the chord is held. */
  hotkeys: Map<string, number> | undefined;
  /** The row whose snooze menu is open. */
  snoozeKey: string | null;
  onSnoozeKeyChange: (key: string | null) => void;
  onToggleLane: (lane: Lane) => void;
  onSelect: (item: QueueItem) => void;
  /** The hero's Open — the mouse twin of `queue-next`. */
  onOpenHead: () => void;
  /** The header `+` — the mouse twin of `ab-new-task`. */
  onNewTask: () => void;
  /** The new-task form, open under the header. */
  newTaskForm?: ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-3 pt-2">
        <span className="text-xs font-medium tracking-wide text-kumo-subtle uppercase">Queue</span>
        <Hint label="New task" shortcut="ab-new-task">
          <button
            type="button"
            onClick={onNewTask}
            aria-label="New task"
            className="rounded-md p-1 text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
          >
            <PlusIcon className="size-3.5" />
          </button>
        </Hint>
      </div>
      {newTaskForm}
      {!live ? (
        <p className="px-3 py-8 text-center text-sm text-kumo-subtle">Not connected yet.</p>
      ) : queue.items.length === 0 ? (
        <p className="px-3 py-8 text-center text-sm text-kumo-subtle">
          No checkouts yet — add a repo or start a task.
        </p>
      ) : (
        <>
          {head && (
            <Hero
              item={head}
              now={now}
              selected={keyId(head.key) === selectedKey}
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
                    const id = keyId(item.key);
                    return (
                      <QueueRow
                        key={id}
                        item={item}
                        now={now}
                        selected={id === selectedKey}
                        hotkey={hotkeys?.get(id)}
                        snoozeOpen={snoozeKey === id}
                        onSnoozeOpenChange={(o) => onSnoozeKeyChange(o ? id : null)}
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
  now,
  selected,
  onOpen,
  onLater,
  onSnooze,
}: {
  item: QueueItem;
  now: number;
  selected: boolean;
  onOpen: () => void;
  onLater: () => void;
  onSnooze: (preset: SnoozePreset) => void;
}) {
  return (
    <motion.div
      key={keyId(item.key)}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "m-2 rounded-lg border border-kumo-brand/40 bg-kumo-brand/5 p-3",
        selected && "ring-1 ring-kumo-brand",
      )}
    >
      <div className="text-[11px] font-semibold tracking-wide text-kumo-brand uppercase">
        Next up{item.reason && ` · ${HERO_KICKER[item.reason]}`}
      </div>
      <div className="mt-0.5 truncate font-semibold">{item.title}</div>
      <div className="truncate font-mono text-xs text-kumo-subtle">
        {[
          item.repo,
          item.branch,
          item.sinceMs != null ? `waiting ${fmtAge(item.sinceMs, now)}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>
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
        {item.reason && <SnoozeMenu onSnooze={onSnooze} />}
        {item.key.kind === "task" && (
          <Button size="xs" variant="ghost" icon={<ArrowDownIcon />} onClick={onLater}>
            Later
          </Button>
        )}
      </div>
    </motion.div>
  );
}

export function SnoozeMenu({
  onSnooze,
  open,
  onOpenChange,
}: {
  onSnooze: (preset: SnoozePreset) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger
        render={
          <Button size="xs" variant="ghost" icon={<ClockIcon />} aria-label="Snooze">
            Snooze
          </Button>
        }
      />
      <DropdownMenu.Content align="start" className="w-auto min-w-44">
        {SNOOZES.map((s) => (
          <DropdownMenu.Item key={s.preset} onClick={() => onSnooze(s.preset)}>
            {s.label}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

function rowMeta(item: QueueItem, now: number): string {
  return [
    item.key.kind === "unfiled" ? "not a task" : null,
    item.branch,
    item.pr ? `PR #${item.pr.number}` : null,
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
  now,
  selected,
  hotkey,
  snoozeOpen,
  onSnoozeOpenChange,
  onSelect,
}: {
  item: QueueItem;
  now: number;
  selected: boolean;
  hotkey: number | undefined;
  snoozeOpen: boolean;
  onSnoozeOpenChange: (open: boolean) => void;
  onSelect: () => void;
}) {
  const face = item.reason ? REASON_FACE[item.reason] : null;
  return (
    <div
      data-focus-kind={item.pr ? "pr" : undefined}
      data-focus-id={item.pr ? `${item.pr.repo}#${item.pr.number}` : undefined}
      className={cn(
        "group flex items-center gap-2 border-t border-kumo-line px-3 py-1.5 text-sm",
        selected && "bg-kumo-tint shadow-[inset_3px_0_0_var(--color-kumo-brand)]",
        item.lane !== "on_you" && "text-kumo-subtle",
      )}
    >
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
        <span className="min-w-0 flex-1">
          <span className="block truncate">{item.title}</span>
          <span className="block truncate font-mono text-xs text-kumo-subtle">
            {rowMeta(item, now)}
          </span>
        </span>
        {item.sinceMs != null && (
          <span className="shrink-0 font-mono text-xs text-kumo-subtle tabular-nums">
            {fmtAge(item.sinceMs, now)}
          </span>
        )}
      </button>
      {/* An idle checkout has nothing in flight to file. */}
      {item.key.kind === "unfiled" && item.lane !== "idle" && (
        <Button size="xs" variant="outline" onClick={() => void fileItem(item)}>
          File
        </Button>
      )}
      {item.snoozed && (
        <Button size="xs" variant="ghost" onClick={() => void unsnoozeItem(item)}>
          Wake
        </Button>
      )}
      {item.reason && !item.snoozed && (
        <SnoozeMenu
          onSnooze={(preset) => void snoozeQueueItem(item, preset)}
          open={snoozeOpen}
          onOpenChange={onSnoozeOpenChange}
        />
      )}
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
