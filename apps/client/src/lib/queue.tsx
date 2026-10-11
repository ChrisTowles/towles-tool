import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { invoke, isTauri } from "./tauri";
import {
  TaskQueueSchema,
  type Lane,
  type QueueItem,
  type TaskQueue,
  type WaitReason,
} from "./schemas/queue";

/** The task queue, one app-wide subscription to `queue://changed`. Status is
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
  return queue.items.find((i) => i.taskId === queue.next);
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

export type Face = { label: string; variant: "red" | "orange" | "blue" | "green" | "neutral" };

export const REASON_FACE: Record<WaitReason, Face> = {
  unblock: { label: "errored", variant: "red" },
  answer: { label: "answer", variant: "orange" },
  review: { label: "review", variant: "blue" },
  fix_ci: { label: "fix CI", variant: "red" },
  address_review: { label: "changes asked", variant: "orange" },
  land: { label: "land", variant: "green" },
  cleanup: { label: "clean up", variant: "neutral" },
};

export const HOUR_MS = 60 * 60 * 1000;

/** Tomorrow 9:00 local, the "come back to it in the morning" snooze. */
export function tomorrowMorning(now: number): number {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

export type SnoozePreset = "1h" | "tomorrow" | "until_change";

export function snoozeUntil(preset: SnoozePreset, now: number): number | null {
  switch (preset) {
    case "1h":
      return now + HOUR_MS;
    case "tomorrow":
      return tomorrowMorning(now);
    case "until_change":
      return null;
  }
}

/** The neighbour to move before/after for a one-step reorder within the visible list. */
export function rankMove(
  items: readonly QueueItem[],
  index: number,
  direction: "up" | "down" | "top",
): "top" | { before: number } | { after: number } | null {
  if (!items[index]) return null;
  if (direction === "top") return "top";
  const neighbour = items[direction === "up" ? index - 1 : index + 1];
  if (!neighbour) return null;
  return direction === "up" ? { before: neighbour.taskId } : { after: neighbour.taskId };
}

export const LANES = ["on_you", "running", "parked", "idle"] as const satisfies readonly Lane[];

/** The rail's rows top-down, folded lanes skipped — what the cursor and the
 * 1–9 jump digits walk. The backend already sorts by lane. */
export function railRows(queue: TaskQueue, folded: ReadonlySet<Lane>): QueueItem[] {
  return queue.items.filter((i) => !folded.has(i.lane));
}

/** The queue narrowed to the repos in `repoKeys` (none picked shows every
 * repo), with Next up re-picked from what's left the way the backend picks it:
 * the first task on you. */
export function filterQueue(
  queue: TaskQueue,
  repoKeys: ReadonlySet<string>,
  repoKeyOf: (folderDir: string) => string | undefined,
): TaskQueue {
  if (repoKeys.size === 0) return queue;
  const items = queue.items.filter((i) => {
    const key = repoKeyOf(i.folderDir);
    return key !== undefined && repoKeys.has(key);
  });
  return { items, next: items.find((i) => i.lane === "on_you")?.taskId ?? null };
}

/** The row standing for a checkout, so picking it any other way still rings it. */
export function rowForFolder(queue: TaskQueue, folderDir: string | null): QueueItem | undefined {
  return folderDir === null ? undefined : queue.items.find((i) => i.folderDir === folderDir);
}

/** One step through `rows` from task `fromId`; off the list lands on the first row. */
export function stepRow(
  rows: readonly QueueItem[],
  fromId: number | null,
  step: 1 | -1,
): QueueItem | undefined {
  if (rows.length === 0) return undefined;
  const at = fromId === null ? -1 : rows.findIndex((r) => r.taskId === fromId);
  if (at === -1) return rows[0];
  return rows[Math.min(rows.length - 1, Math.max(0, at + step))];
}

/** The head of On you — what "the next thing needing you" means. */
export function onYouHead(queue: TaskQueue): QueueItem | undefined {
  return queue.items.find((i) => i.lane === "on_you");
}

/** When the head of On you changes: open it in place when nothing you're
 * doing would be interrupted, else announce it. A focused terminal is never
 * taken from you, and neither is a row that still needs you. */
export function nextUpArrival(
  prevHeadId: number | null | undefined,
  head: QueueItem | undefined,
  ctx: { terminalFocused: boolean; selectedId: number | null; selectedOnYou: boolean },
): "open" | "announce" | null {
  if (!head) return null;
  if (head.taskId === prevHeadId || head.taskId === ctx.selectedId) return null;
  if (prevHeadId === undefined) {
    return ctx.selectedId === null && !ctx.terminalFocused ? "open" : null;
  }
  if (ctx.terminalFocused) return "announce";
  return ctx.selectedId === null || !ctx.selectedOnYou ? "open" : "announce";
}
