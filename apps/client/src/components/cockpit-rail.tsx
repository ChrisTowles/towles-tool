import { useMemo, type ReactNode } from "react";
import { motion } from "motion/react";
import { Badge, Button, DropdownMenu } from "@cloudflare/kumo";
import {
  ArrowDownIcon,
  CaretDownIcon,
  CaretRightIcon,
  ClockIcon,
  EyeSlashIcon,
  PlayIcon,
} from "@phosphor-icons/react";
import { HotkeyBadge } from "@/components/agentboard-bits";
import { requestAgentboardNav } from "@/lib/agentboard";
import { fmtAge, storeItemDismiss } from "@/lib/data";
import { errorMessage, NotInTauri } from "@/lib/errors";
import { openExternalUrl } from "@/lib/open-url";
import {
  itemUrl,
  keyId,
  LANES,
  primaryAction,
  rankMove,
  REASON_FACE,
  snoozeUntil,
  type SnoozePreset,
} from "@/lib/queue";
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
  review_pr: "your review is requested",
  land: "ready to land",
  cleanup: "landed — clean it up",
  start: "nothing waiting on you — start next",
};

const LANE_TITLE: Record<Lane, string> = {
  on_you: "On you",
  running: "Running",
  parked: "Parked",
  backlog: "Backlog",
};

export const FOLDED_BY_DEFAULT: Lane[] = ["parked", "backlog"];

const SNOOZES: { preset: SnoozePreset; label: string }[] = [
  { preset: "1h", label: "For an hour" },
  { preset: "tomorrow", label: "Until tomorrow 9:00" },
  { preset: "until_change", label: "Until it changes" },
];

async function report(r: Awaited<ReturnType<typeof invoke>>) {
  if (r.isErr() && !NotInTauri.is(r.error)) toast.error(errorMessage(r.error));
}

/** The `+` flow for a task with no checkout yet. */
export async function startQueueItem(item: QueueItem): Promise<void> {
  if (item.key.kind !== "task") return;
  uiAction("queue.start", "cockpit");
  await report(await invoke<void>("queue_start", { id: item.key.id }));
}

export function openQueueLink(item: QueueItem): void {
  const url = itemUrl(item);
  if (!url) return;
  uiAction("queue.open_link", "cockpit", item.key.kind);
  void openExternalUrl(url);
}

export async function snoozeQueueItem(item: QueueItem, preset: SnoozePreset): Promise<void> {
  if (item.key.kind !== "task" || !item.reason) return;
  uiAction("queue.snooze", "cockpit", preset);
  await report(
    await invoke<void>("queue_snooze", {
      id: item.key.id,
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
  if (item.key.kind !== "task") return;
  uiAction("queue.unsnooze", "cockpit");
  await report(await invoke<void>("queue_unsnooze", { id: item.key.id }));
}

async function fileItem(item: QueueItem) {
  if (item.key.kind !== "unfiled") return;
  uiAction("queue.file", "cockpit");
  await report(await invoke<number>("queue_file_unfiled", { folderDir: item.key.folderDir }));
}

/** A PR row's way off the queue; the snapshot re-emits and the row goes. */
export async function dismissQueuePr(item: QueueItem): Promise<void> {
  const pr = item.pr;
  if (item.key.kind !== "pr" || !pr) return;
  uiAction("cockpit.item_dismiss", "cockpit", "pr");
  // The row's age is the PR's `updatedTs`, which a dismissal must cover.
  const r = await storeItemDismiss("pr", pr.repo, pr.number, item.sinceMs ?? Date.now());
  if (r.isErr() && !NotInTauri.is(r.error)) toast.error(r.error.message);
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

/** The left rail: Next up, then every lane. Rows only select — the item's
 * terminals open beside it; nothing here acts on an agent. */
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
  children,
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
  /** Drawers below the lanes (issues, checkouts). */
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col">
      {!live ? (
        <p className="px-3 py-8 text-center text-sm text-kumo-subtle">Not connected yet.</p>
      ) : queue.items.length === 0 ? (
        <p className="px-3 py-8 text-center text-sm text-kumo-subtle">
          Nothing needs you — add a task on the Board.
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
      {children}
    </div>
  );
}

/** A rail drawer: a folded section under the lanes. */
export function RailDrawer({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mt-2 border-t">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1 px-3 pt-3 pb-1 text-left text-xs font-medium tracking-wide text-kumo-subtle uppercase hover:text-kumo-default"
      >
        {open ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
        {title}
        {count !== undefined && ` · ${count}`}
      </button>
      {open && children}
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
  const reason = item.reason ?? "start";
  return (
    <motion.div
      key={keyId(item.key)}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "m-2 rounded-lg border p-3",
        reason === "start"
          ? "border-kumo-success/40 bg-kumo-success/5"
          : "border-kumo-brand/40 bg-kumo-brand/5",
        selected && "ring-1 ring-kumo-brand",
      )}
    >
      <div className="text-[11px] font-semibold tracking-wide text-kumo-brand uppercase">
        Next up · {HERO_KICKER[reason]}
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
        {item.key.kind === "task" && item.reason && <SnoozeMenu onSnooze={onSnooze} />}
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
    item.key.kind === "pr" || item.key.kind === "ci" ? item.repo : null,
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
      {item.key.kind === "unfiled" && (
        <Button size="xs" variant="outline" onClick={() => void fileItem(item)}>
          File
        </Button>
      )}
      {item.snoozed && (
        <Button size="xs" variant="ghost" onClick={() => void unsnoozeItem(item)}>
          Wake
        </Button>
      )}
      {item.key.kind === "pr" && (
        <Button
          size="xs"
          variant="ghost"
          shape="square"
          aria-label="Dismiss PR"
          className="opacity-0 group-hover:opacity-100"
          icon={<EyeSlashIcon />}
          onClick={() => void dismissQueuePr(item)}
        />
      )}
      {item.key.kind === "task" && item.reason && !item.snoozed && (
        <SnoozeMenu
          onSnooze={(preset) => void snoozeQueueItem(item, preset)}
          open={snoozeOpen}
          onOpenChange={onSnoozeOpenChange}
        />
      )}
    </div>
  );
}

/** What a selected row with no checkout shows where its panes would be. */
export function QueueDetail({ item, now }: { item: QueueItem; now: number }) {
  const action = primaryAction(item);
  const reason = item.reason ?? "start";
  return (
    <div className="flex h-full items-start justify-center overflow-auto p-8">
      <div className="w-full max-w-xl rounded-lg border p-5">
        <div className="text-xs font-semibold tracking-wide text-kumo-brand uppercase">
          {item.reason ? HERO_KICKER[reason] : LANE_TITLE[item.lane]}
        </div>
        <div className="mt-1 text-lg font-semibold">{item.title}</div>
        <div className="font-mono text-xs text-kumo-subtle">{rowMeta(item, now)}</div>
        {item.goal && item.goal !== item.title && (
          <p className="mt-3 text-sm whitespace-pre-wrap">{item.goal}</p>
        )}
        {item.ci.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1 text-sm">
            {item.ci.map((c) => (
              <li key={c.workflow}>
                <button
                  type="button"
                  className="text-left hover:underline"
                  onClick={() => {
                    uiAction("cockpit.open_ci_run", "cockpit", c.conclusion);
                    void openExternalUrl(c.url);
                  }}
                >
                  <Badge variant="red">{c.workflow}</Badge>{" "}
                  <span className="text-xs text-kumo-subtle">
                    {c.conclusion} · {fmtAge(c.updatedMs, now)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          {action === "start" && item.key.kind === "task" && (
            <Button
              size="sm"
              variant="primary"
              icon={<PlayIcon weight="fill" />}
              onClick={() => void startQueueItem(item)}
            >
              Start agent{" "}
              <span className="ml-1 text-xs opacity-70">{shortcutHint("queue-start")}</span>
            </Button>
          )}
          {action === "open-link" && (
            <Button size="sm" variant="primary" onClick={() => openQueueLink(item)}>
              Open on GitHub{" "}
              <span className="ml-1 text-xs opacity-70">{shortcutHint("ab-focus-terminal")}</span>
            </Button>
          )}
          {item.key.kind === "pr" && (
            <Button
              size="sm"
              variant="ghost"
              icon={<EyeSlashIcon />}
              onClick={() => void dismissQueuePr(item)}
            >
              Dismiss
            </Button>
          )}
        </div>
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
  const reason = item.reason ?? "start";
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      role="status"
      className="flex shrink-0 items-center gap-2 border-b border-kumo-brand/40 bg-kumo-brand/10 px-3 py-1.5 text-sm"
    >
      <span className="text-xs font-semibold tracking-wide text-kumo-brand uppercase">Next up</span>
      <span className="min-w-0 truncate font-medium">{item.title}</span>
      <span className="shrink-0 text-xs text-kumo-subtle">{HERO_KICKER[reason]}</span>
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
