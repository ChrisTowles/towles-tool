import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { fmtStateAge } from "./agentboard/session";
import { invoke, isTauri } from "./tauri";
import {
  TaskQueueSchema,
  type Lane,
  type QueueItem,
  type TaskQueue,
  type WaitReason,
} from "./schemas/queue";

/** The queue — every checkout, ordered by what needs you — one app-wide subscription to `queue://changed`. Status is
 * only *reported*: acting on an item navigates to its real terminal. */

const EMPTY: TaskQueue = { next: null, items: [] };

const TaskQueueContext = createContext<{ queue: TaskQueue; live: boolean } | null>(null);

export function TaskQueueProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState({ queue: EMPTY, live: false });

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let accepted = false;
    let unlisten: (() => void) | undefined;
    const accept = (raw: unknown) => {
      const parsed = TaskQueueSchema.safeParse(raw);
      if (!parsed.success) {
        console.error("queue://changed: unexpected payload", parsed.error);
        return;
      }
      accepted = true;
      setState({ queue: parsed.data, live: true });
    };
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const sub = await listen<unknown>("queue://changed", (e) => accept(e.payload));
      if (disposed) {
        sub();
        return;
      }
      unlisten = sub;
      // `null` until the store has opened, and the app emits only on a change
      // after that — so keep asking until something lands.
      const settled = () => disposed || accepted;
      for (let attempt = 0; attempt < 30 && !settled(); attempt++) {
        const initial = await invoke<unknown>("queue_get");
        if (initial.isOk() && initial.value != null && !disposed) {
          accept(initial.value);
          return;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return <TaskQueueContext.Provider value={state}>{children}</TaskQueueContext.Provider>;
}

export function useTaskQueue(): { queue: TaskQueue; live: boolean } {
  const ctx = useContext(TaskQueueContext);
  if (ctx === null) throw new Error("useTaskQueue must be used within a TaskQueueProvider");
  return ctx;
}

export function nextItem(queue: TaskQueue): QueueItem | undefined {
  return queue.items.find((i) => i.folderDir === queue.next);
}

/** The next/previous stop for `ab-jump-next`: queue items that have a session,
 * in queue order. A session not in the queue (already answered) restarts from the head. */
export function cycleQueue(
  queue: TaskQueue,
  fromSessionId: string | null,
  direction: "next" | "prev",
): string | null {
  const ids = queue.items.flatMap((i) => (i.lane === "on_you" && i.sessionId ? [i.sessionId] : []));
  if (ids.length === 0) return null;
  const from = fromSessionId ? ids.indexOf(fromSessionId) : -1;
  if (from === -1) return direction === "next" ? ids[0] : ids[ids.length - 1];
  const step = direction === "next" ? 1 : -1;
  return ids[(from + step + ids.length) % ids.length];
}

export type Tone = "red" | "orange" | "blue" | "green" | "neutral";

/** The chip's words are the backend's `why`; this is only its tint. */
export const REASON_TONE: Record<WaitReason, Tone> = {
  unblock: "red",
  answer: "orange",
  review: "blue",
  fix_ci: "red",
  address_review: "orange",
  land: "green",
  cleanup: "neutral",
};

/** What the row's chip says — why it's on you and for how long ("asking 4m"),
 * or, off that lane, what the agent is doing and for how long ("working 12m"). */
export function reasonChip(item: QueueItem, now: number): string | null {
  if (item.why) return fmtStateAge(item.why, item.sinceMs, now) ?? item.why;
  switch (item.lane) {
    case "running":
      return fmtStateAge("working", item.sinceMs, now);
    case "idle":
      return fmtStateAge("idle", item.sinceMs, now);
    default:
      return null;
  }
}

const HOUR_MS = 60 * 60 * 1000;

/** Tomorrow 9:00 local, the "come back to it in the morning" snooze. */
export function tomorrowMorning(now: number): number {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

export type SnoozePreset = "1h" | "tomorrow" | "until_change" | "until_ci";

export function snoozeUntil(preset: SnoozePreset, now: number): number | null {
  switch (preset) {
    case "1h":
      return now + HOUR_MS;
    case "tomorrow":
      return tomorrowMorning(now);
    case "until_change":
    case "until_ci":
      return null;
  }
}

/** The presets a row offers: "until CI finishes" only while its PR's checks run. */
export function snoozePresets(item: QueueItem): SnoozePreset[] {
  const base: SnoozePreset[] = ["1h", "tomorrow", "until_change"];
  return item.pr?.checks === "pending" ? [...base, "until_ci"] : base;
}

/** The task to move before/after for a one-step reorder within the visible
 * list. Only task rows carry a rank, so checkouts no task owns are stepped over. */
export function rankMove(
  items: readonly QueueItem[],
  index: number,
  direction: "up" | "down" | "top",
): "top" | { before: number } | { after: number } | null {
  if (items[index]?.taskId == null) return null;
  if (direction === "top") return "top";
  const step = direction === "up" ? -1 : 1;
  for (let i = index + step; i >= 0 && i < items.length; i += step) {
    const id = items[i].taskId;
    if (id != null) return direction === "up" ? { before: id } : { after: id };
  }
  return null;
}

export const LANES = [
  "on_you",
  "idle",
  "running",
  "parked",
  "no_shell",
] as const satisfies readonly Lane[];

/** The rail's rows top-down, folded lanes skipped — what the cursor and the
 * 1–9 jump digits walk. The backend already sorts by lane. */
export function railRows(queue: TaskQueue, folded: ReadonlySet<Lane>): QueueItem[] {
  return queue.items.filter((i) => !folded.has(i.lane));
}

/** The queue narrowed to the checkouts the tree has (`onRail`) and then to the
 * repos in `repoKeys` (none picked shows every repo), with Next up re-picked
 * from what's left the way the backend picks it: the first row on you. */
export function filterQueue(
  queue: TaskQueue,
  onRail: (folderDir: string) => boolean,
  repoKeys: ReadonlySet<string>,
  repoKeyOf: (folderDir: string) => string | undefined,
): TaskQueue {
  const items = queue.items.filter((i) => {
    if (!onRail(i.folderDir)) return false;
    if (repoKeys.size === 0) return true;
    const key = repoKeyOf(i.folderDir);
    return key !== undefined && repoKeys.has(key);
  });
  if (items.length === queue.items.length) return queue;
  return { items, next: items.find((i) => i.lane === "on_you")?.folderDir ?? null };
}

/** The row standing for a checkout, so picking it any other way still rings it. */
export function rowForFolder(queue: TaskQueue, folderDir: string | null): QueueItem | undefined {
  return folderDir === null ? undefined : queue.items.find((i) => i.folderDir === folderDir);
}

/** One step through `rows` from checkout `fromDir`; off the list lands on the first row. */
export function stepRow(
  rows: readonly QueueItem[],
  fromDir: string | null,
  step: 1 | -1,
): QueueItem | undefined {
  if (rows.length === 0) return undefined;
  const at = fromDir === null ? -1 : rows.findIndex((r) => r.folderDir === fromDir);
  if (at === -1) return rows[0];
  return rows[Math.min(rows.length - 1, Math.max(0, at + step))];
}

/** The head of On you — what "the next thing needing you" means. */
export function onYouHead(queue: TaskQueue): QueueItem | undefined {
  return queue.items.find((i) => i.lane === "on_you");
}

/** When the head of On you changes, open it in place only when nothing is open
 * and nothing is being typed in. Otherwise nothing happens: the queue is where
 * you go when you're done, never something that calls you over. */
export function nextUpArrival(
  prevHeadId: string | null | undefined,
  head: QueueItem | undefined,
  ctx: { terminalFocused: boolean; selectedId: string | null },
): "open" | null {
  if (!head) return null;
  if (head.folderDir === prevHeadId || head.folderDir === ctx.selectedId) return null;
  return ctx.selectedId === null && !ctx.terminalFocused ? "open" : null;
}
