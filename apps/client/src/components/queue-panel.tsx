import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { Badge, Button, DropdownMenu } from "@cloudflare/kumo";
import {
  ArrowDownIcon,
  CaretDownIcon,
  CaretRightIcon,
  ClockIcon,
  PlayIcon,
  QueueIcon,
} from "@phosphor-icons/react";
import { Empty, Panel } from "@/components/store-bits";
import { requestAgentboardNav } from "@/lib/agentboard";
import { fmtAge } from "@/lib/data";
import { openExternalUrl } from "@/lib/open-url";
import { errorMessage, NotInTauri } from "@/lib/errors";
import {
  keyId,
  itemUrl,
  nextItem,
  primaryAction,
  rankMove,
  REASON_FACE,
  snoozeUntil,
  type SnoozePreset,
  useTaskQueue,
} from "@/lib/queue";
import type { ScreenId } from "@/lib/screens";
import type { Lane, QueueItem, TaskQueue, WaitReason } from "@/lib/schemas/queue";
import { mouseAction } from "@/lib/shortcut-coach";
import { shortcutHint, useShortcuts } from "@/lib/shortcuts";
import { invoke } from "@/lib/tauri";
import { toast } from "@/lib/toast";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";

const HERO_KICKER: Record<WaitReason, string> = {
  unblock: "Next up · an agent errored",
  answer: "Next up · an agent is waiting on you",
  review: "Next up · an agent finished — review it",
  fix_ci: "Next up · CI is failing",
  address_review: "Next up · changes requested",
  review_pr: "Next up · your review is requested",
  land: "Next up · ready to land",
  cleanup: "Next up · landed — clean it up",
  start: "Nothing waiting on you — start next",
};

const LANE_TITLE: Record<Lane, string> = {
  on_you: "On you",
  running: "Running",
  parked: "Parked",
  backlog: "Backlog",
};

const FOLDED_BY_DEFAULT: Lane[] = ["running", "parked", "backlog"];

const SNOOZES: { preset: SnoozePreset; label: string }[] = [
  { preset: "1h", label: "For an hour" },
  { preset: "tomorrow", label: "Until tomorrow 9:00" },
  { preset: "until_change", label: "Until it changes" },
];

/** Enter on a row, the hero's button, and the global `queue-next` all land here. */
export function openQueueItem(
  item: QueueItem,
  openTab: (id: ScreenId) => void,
  screen: ScreenId,
): void {
  uiAction("queue.open", screen, item.reason ?? item.lane);
  const action = primaryAction(item);
  if (action === "start") {
    void startQueueItem(item, screen);
    return;
  }
  if (action === "open-link") {
    const url = itemUrl(item);
    if (url) void openExternalUrl(url);
    return;
  }
  const folderDir = item.folderDir ?? "";
  requestAgentboardNav(
    action === "open-session" && item.sessionId
      ? { kind: "session", folderDir, sessionId: item.sessionId }
      : { kind: "folder", folderDir },
  );
  openTab("agentboard");
  if (item.reason === "land") toast.info("Run /done in the task's terminal to land it.");
}

async function startQueueItem(item: QueueItem, screen: ScreenId): Promise<void> {
  if (item.key.kind !== "task") return;
  uiAction("queue.start", screen);
  const r = await invoke<void>("queue_start", { id: item.key.id });
  if (r.isErr() && !NotInTauri.is(r.error)) toast.error(errorMessage(r.error));
}

async function unsnoozeItem(item: QueueItem) {
  if (item.key.kind !== "task") return;
  uiAction("queue.unsnooze", "cockpit");
  const r = await invoke<void>("queue_unsnooze", { id: item.key.id });
  if (r.isErr() && !NotInTauri.is(r.error)) toast.error(errorMessage(r.error));
}

async function fileItem(item: QueueItem) {
  if (item.key.kind !== "unfiled") return;
  uiAction("queue.file", "cockpit");
  const r = await invoke<number>("queue_file_unfiled", { folderDir: item.key.folderDir });
  if (r.isErr() && !NotInTauri.is(r.error)) toast.error(errorMessage(r.error));
}

/** `queue-next` from any screen, terminals included. */
export function QueueNextShortcut() {
  const { openTab, activeTab } = useWorkspace();
  const { queue } = useTaskQueue();
  useShortcuts(
    useMemo(
      () => ({
        "queue-next": () => {
          const head = nextItem(queue);
          if (head) openQueueItem(head, openTab, activeTab);
          else toast.info("Queue's empty — nothing needs you.");
        },
      }),
      [queue, openTab, activeTab],
    ),
    activeTab,
  );
  return null;
}

/** The cockpit's task queue: Next up, then every open task by lane. Rows only
 * navigate to the real terminal or start the `+` flow — never act on an agent. */
export function QueuePanel({ queue, now, live }: { queue: TaskQueue; now: number; live: boolean }) {
  const { openTab, activeTab } = useWorkspace();
  const [folded, setFolded] = useState<Set<Lane>>(() => new Set(FOLDED_BY_DEFAULT));
  const [selected, setSelected] = useState<string | null>(null);
  const [snoozeFor, setSnoozeFor] = useState<string | null>(null);
  const head = nextItem(queue);

  const lanes = useMemo(() => {
    const by = new Map<Lane, QueueItem[]>();
    for (const item of queue.items) by.set(item.lane, [...(by.get(item.lane) ?? []), item]);
    return by;
  }, [queue.items]);
  const visible = queue.items.filter((i) => !folded.has(i.lane));
  const selIndex = Math.max(
    0,
    visible.findIndex((i) => keyId(i.key) === selected),
  );
  const current = visible[selIndex];

  const open = (item: QueueItem) => openQueueItem(item, openTab, "cockpit");
  const start = (item: QueueItem) => startQueueItem(item, "cockpit");

  async function snooze(item: QueueItem, preset: SnoozePreset) {
    setSnoozeFor(null);
    if (item.key.kind !== "task" || !item.reason) return;
    uiAction("queue.snooze", "cockpit", preset);
    const r = await invoke<void>("queue_snooze", {
      id: item.key.id,
      reason: item.reason,
      untilMs: snoozeUntil(preset, Date.now()),
    });
    if (r.isErr() && !NotInTauri.is(r.error)) toast.error(errorMessage(r.error));
  }

  async function rerank(item: QueueItem, direction: "up" | "down" | "top") {
    const index = queue.items.indexOf(item);
    const to = rankMove(queue.items, index, direction);
    if (!to || item.key.kind !== "task") return;
    uiAction("queue.reorder", "cockpit", direction);
    const r = await invoke<void>("queue_move", { id: item.key.id, to });
    if (r.isErr() && !NotInTauri.is(r.error)) toast.error(errorMessage(r.error));
  }

  function toggleLane(lane: Lane) {
    uiAction("queue.lane_toggle", "cockpit", lane);
    setFolded((cur) => {
      const nextSet = new Set(cur);
      if (nextSet.has(lane)) nextSet.delete(lane);
      else nextSet.add(lane);
      return nextSet;
    });
  }

  function move(step: number) {
    if (visible.length === 0) return;
    const i = Math.min(visible.length - 1, Math.max(0, selIndex + step));
    setSelected(keyId(visible[i].key));
  }

  useShortcuts(
    useMemo(
      () => ({
        "queue-down": () => move(1),
        "queue-up": () => move(-1),
        "queue-open": () => {
          if (!current) return false;
          open(current);
        },
        "queue-start": () => {
          if (current?.key.kind === "task" && !current.folderDir) void start(current);
        },
        "queue-snooze": () => {
          if (current?.key.kind === "task" && current.reason) setSnoozeFor(keyId(current.key));
        },
        "queue-rank-up": () => current && void rerank(current, "up"),
        "queue-rank-down": () => current && void rerank(current, "down"),
        "queue-rank-top": () => current && void rerank(current, "top"),
      }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [current, visible.length, selIndex],
    ),
    "cockpit",
    activeTab === "cockpit",
  );

  const onYou = lanes.get("on_you")?.length ?? 0;
  const note = live
    ? `${onYou} on you · ${lanes.get("running")?.length ?? 0} running · ${shortcutHint("queue-next")} next`
    : undefined;

  return (
    <div className="lg:col-span-2">
      <Panel title="Queue" note={note} icon={<QueueIcon size={16} />}>
        {!live ? (
          <Empty>Not connected yet.</Empty>
        ) : queue.items.length === 0 ? (
          <Empty>No open tasks — add one on the Board.</Empty>
        ) : (
          <>
            {head && (
              <Hero
                item={head}
                now={now}
                onOpen={() => {
                  mouseAction("queue-open", "cockpit");
                  open(head);
                }}
                onLater={() => void rerank(head, "down")}
                onSnooze={(preset) => void snooze(head, preset)}
              />
            )}
            {(["on_you", "running", "parked", "backlog"] as const).map((lane) => {
              const items = lanes.get(lane) ?? [];
              if (items.length === 0) return null;
              const isFolded = folded.has(lane);
              return (
                <div key={lane}>
                  <button
                    type="button"
                    onClick={() => toggleLane(lane)}
                    className="flex w-full items-center gap-1 px-3 pt-3 pb-1 text-left text-xs font-medium tracking-wide text-kumo-subtle uppercase hover:text-kumo-default"
                  >
                    {isFolded ? <CaretRightIcon size={12} /> : <CaretDownIcon size={12} />}
                    {LANE_TITLE[lane]} · {items.length}
                  </button>
                  {!isFolded &&
                    items.map((item) => (
                      <QueueRow
                        key={keyId(item.key)}
                        item={item}
                        now={now}
                        selected={current !== undefined && keyId(current.key) === keyId(item.key)}
                        snoozeOpen={snoozeFor === keyId(item.key)}
                        onSnoozeOpenChange={(o) => setSnoozeFor(o ? keyId(item.key) : null)}
                        onOpen={() => {
                          mouseAction("queue-open", "cockpit");
                          setSelected(keyId(item.key));
                          open(item);
                        }}
                        onSnooze={(preset) => void snooze(item, preset)}
                        onUnsnooze={() => void unsnoozeItem(item)}
                        onFile={() => void fileItem(item)}
                      />
                    ))}
                </div>
              );
            })}
          </>
        )}
      </Panel>
    </div>
  );
}

function Hero({
  item,
  now,
  onOpen,
  onLater,
  onSnooze,
}: {
  item: QueueItem;
  now: number;
  onOpen: () => void;
  onLater: () => void;
  onSnooze: (preset: SnoozePreset) => void;
}) {
  const reason = item.reason ?? "start";
  const action = primaryAction(item);
  const verb =
    action === "start" ? "Start agent" : action === "open-link" ? "Open on GitHub" : "Open";
  return (
    <motion.div
      key={keyId(item.key)}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "m-3 rounded-lg border p-4",
        reason === "start"
          ? "border-kumo-success/40 bg-kumo-success/5"
          : "border-kumo-brand/40 bg-kumo-brand/5",
      )}
    >
      <div className="text-xs font-semibold tracking-wide text-kumo-brand uppercase">
        {HERO_KICKER[reason]}
      </div>
      <div className="mt-1 text-base font-semibold">{item.title}</div>
      <div className="font-mono text-xs text-kumo-subtle">
        {[
          item.repo,
          item.branch,
          item.sinceMs != null ? `waiting ${fmtAge(item.sinceMs, now)}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>
      {item.said && item.said !== item.title && (
        <div className="mt-3 rounded-md border-l-2 border-kumo-warning bg-kumo-tint px-3 py-2 text-sm">
          {item.said}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" icon={<PlayIcon weight="fill" />} onClick={onOpen}>
          {verb} <span className="ml-1 text-xs opacity-70">{shortcutHint("queue-open")}</span>
        </Button>
        {item.key.kind === "task" && item.reason && <SnoozeMenu onSnooze={onSnooze} />}
        {item.key.kind === "task" && (
          <Button size="sm" variant="ghost" icon={<ArrowDownIcon />} onClick={onLater}>
            Later
          </Button>
        )}
      </div>
    </motion.div>
  );
}

function SnoozeMenu({
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
          <Button size="sm" variant="ghost" icon={<ClockIcon />} aria-label="Snooze">
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

function QueueRow({
  item,
  now,
  selected,
  snoozeOpen,
  onSnoozeOpenChange,
  onOpen,
  onSnooze,
  onUnsnooze,
  onFile,
}: {
  item: QueueItem;
  now: number;
  selected: boolean;
  snoozeOpen: boolean;
  onSnoozeOpenChange: (open: boolean) => void;
  onOpen: () => void;
  onSnooze: (preset: SnoozePreset) => void;
  onUnsnooze: () => void;
  onFile: () => void;
}) {
  const face = item.reason ? REASON_FACE[item.reason] : null;
  const meta = [
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
  ].filter(Boolean);
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-t border-kumo-line px-3 py-2 text-sm",
        selected && "bg-kumo-tint shadow-[inset_3px_0_0_var(--color-kumo-brand)]",
        item.lane !== "on_you" && "text-kumo-subtle",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        {face ? (
          <Badge variant={face.variant} className="w-24 shrink-0 justify-center">
            {face.label}
            {item.also.length > 0 && ` +${item.also.length}`}
          </Badge>
        ) : (
          <span className="w-24 shrink-0" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{item.title}</span>
          <span className="block truncate font-mono text-xs text-kumo-subtle">
            {meta.join(" · ")}
          </span>
        </span>
        {item.sinceMs != null && (
          <span className="shrink-0 font-mono text-xs text-kumo-subtle tabular-nums">
            {fmtAge(item.sinceMs, now)}
          </span>
        )}
      </button>
      {item.key.kind === "unfiled" && (
        <Button size="xs" variant="outline" onClick={onFile}>
          File
        </Button>
      )}
      {item.snoozed && (
        <Button size="xs" variant="ghost" onClick={onUnsnooze}>
          Wake
        </Button>
      )}
      {item.key.kind === "task" && item.reason && !item.snoozed && (
        <SnoozeMenu onSnooze={onSnooze} open={snoozeOpen} onOpenChange={onSnoozeOpenChange} />
      )}
    </div>
  );
}
