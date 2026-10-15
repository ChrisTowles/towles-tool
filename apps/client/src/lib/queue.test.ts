import { describe, expect, it } from "vitest";
import {
  cycleQueue,
  filterQueue,
  nextItem,
  nextUpArrival,
  onYouHead,
  railRows,
  rowForFolder,
  stepRow,
  rankMove,
  snoozeUntil,
  tomorrowMorning,
} from "./queue";
import { TaskQueueSchema, type QueueItem, type TaskQueue } from "./schemas/queue";

function item(id: number, over: Partial<QueueItem> = {}): QueueItem {
  return {
    taskId: id,
    lane: "on_you",
    reason: "answer",
    also: [],
    title: `t${id}`,
    repo: "o/r",
    branch: `feat/${id}`,
    folderDir: `/w${id}`,
    sessionId: `s${id}`,
    said: null,
    runningAgents: 0,
    pr: null,
    ci: [],
    rank: id * 1024,
    sinceMs: null,
    snoozedUntilMs: null,
    snoozed: false,
    ...over,
  };
}

const queue = (items: QueueItem[]): TaskQueue => ({ next: items[0]?.folderDir ?? null, items });
const dir = (id: number) => `/w${id}`;

describe("cycleQueue", () => {
  const q = queue([item(1), item(2), item(3, { lane: "running" })]);
  it("walks on-you sessions in queue order and wraps", () => {
    expect(cycleQueue(q, null, "next")).toBe("s1");
    expect(cycleQueue(q, "s1", "next")).toBe("s2");
    expect(cycleQueue(q, "s2", "next")).toBe("s1");
    expect(cycleQueue(q, "s1", "prev")).toBe("s2");
  });
  it("restarts from the head for a session no longer waiting", () => {
    expect(cycleQueue(q, "s3", "next")).toBe("s1");
  });
  it("is null on an empty queue", () => {
    expect(cycleQueue(queue([]), null, "next")).toBeNull();
  });
});

describe("rankMove", () => {
  const items = [item(1), item(2), item(3)];
  it("moves before/after the neighbouring task, or to the top", () => {
    expect(rankMove(items, 1, "up")).toEqual({ before: 1 });
    expect(rankMove(items, 1, "down")).toEqual({ after: 3 });
    expect(rankMove(items, 2, "top")).toBe("top");
  });
  it("declines past either end", () => {
    expect(rankMove(items, 0, "up")).toBeNull();
    expect(rankMove(items, 2, "down")).toBeNull();
  });
  it("steps over checkouts no task owns, and never moves one", () => {
    const mixed = [item(1), item(2, { taskId: null, rank: null }), item(3)];
    expect(rankMove(mixed, 2, "up")).toEqual({ before: 1 });
    expect(rankMove(mixed, 0, "down")).toEqual({ after: 3 });
    expect(rankMove(mixed, 1, "top")).toBeNull();
  });
});

describe("snooze presets", () => {
  const now = new Date(2026, 9, 10, 15, 30).getTime();
  it("an hour, tomorrow 9:00, or until it changes", () => {
    expect(snoozeUntil("1h", now)).toBe(now + 3_600_000);
    expect(snoozeUntil("tomorrow", now)).toBe(new Date(2026, 9, 11, 9, 0).getTime());
    expect(tomorrowMorning(now)).toBe(new Date(2026, 9, 11, 9, 0).getTime());
    expect(snoozeUntil("until_change", now)).toBeNull();
  });
});

describe("schema + nextItem", () => {
  it("parses the Rust shape and finds the head", () => {
    const raw = { next: dir(2), items: [item(1), item(2), item(3, { taskId: null, rank: null })] };
    const parsed = TaskQueueSchema.parse(raw);
    expect(nextItem(parsed)?.title).toBe("t2");
  });
});

describe("rail rows", () => {
  const q = queue([item(1), item(2, { lane: "running" }), item(3, { lane: "idle" })]);
  it("skip folded lanes and find a checkout's row", () => {
    expect(railRows(q, new Set(["running"])).map((i) => i.title)).toEqual(["t1", "t3"]);
    expect(rowForFolder(q, "/w2")?.title).toBe("t2");
    expect(rowForFolder(q, null)).toBeUndefined();
    expect(onYouHead(q)?.title).toBe("t1");
  });
  it("step within bounds, from nothing to the first", () => {
    const rows = railRows(q, new Set());
    expect(stepRow(rows, null, 1)?.title).toBe("t1");
    expect(stepRow(rows, dir(1), 1)?.title).toBe("t2");
    expect(stepRow(rows, dir(3), 1)?.title).toBe("t3");
    expect(stepRow(rows, dir(1), -1)?.title).toBe("t1");
    expect(stepRow([], null, 1)).toBeUndefined();
  });
});

const REPO_OF: Record<string, string> = { "/w1": "a", "/w2": "b", "/w3": "b" };
const repoOf = (folderDir: string): string | undefined => REPO_OF[folderDir];
const all = () => true;

describe("filterQueue", () => {
  const q = queue([item(1), item(2, { lane: "running" }), item(3)]);
  it("shows every repo while none is picked", () => {
    expect(filterQueue(q, all, new Set(), repoOf)).toBe(q);
  });
  it("keeps the picked repos' rows and re-picks Next up among them", () => {
    const b = filterQueue(q, all, new Set(["b"]), repoOf);
    expect(b.items.map((i) => i.folderDir)).toEqual([dir(2), dir(3)]);
    expect(b.next).toBe(dir(3));
  });
  it("has no Next up when nothing picked waits on you", () => {
    expect(filterQueue(q, all, new Set(["c"]), repoOf)).toEqual({ items: [], next: null });
  });
  it("drops checkouts the tree doesn't show", () => {
    const shown = filterQueue(q, (d) => d !== dir(1), new Set(), repoOf);
    expect(shown.items.map((i) => i.folderDir)).toEqual([dir(2), dir(3)]);
    expect(shown.next).toBe(dir(3));
  });
});

describe("nextUpArrival", () => {
  const head = item(2);
  const idle = { terminalFocused: false, selectedId: null };
  it("opens on first sight only when nothing is selected or typed in", () => {
    expect(nextUpArrival(undefined, head, idle)).toBe("open");
    expect(nextUpArrival(undefined, head, { ...idle, terminalFocused: true })).toBeNull();
    expect(nextUpArrival(undefined, head, { ...idle, selectedId: dir(9) })).toBeNull();
  });
  it("ignores an unchanged head or one already on screen", () => {
    expect(nextUpArrival(dir(2), head, idle)).toBeNull();
    expect(nextUpArrival(dir(1), head, { ...idle, selectedId: dir(2) })).toBeNull();
    expect(nextUpArrival(dir(1), undefined, idle)).toBeNull();
  });
  it("never swaps out what you have open, and never calls you over", () => {
    expect(nextUpArrival(dir(1), head, { ...idle, terminalFocused: true })).toBeNull();
    expect(nextUpArrival(dir(1), head, { ...idle, selectedId: dir(1) })).toBeNull();
  });
  it("opens a new head when nothing is open", () => {
    expect(nextUpArrival(dir(1), head, idle)).toBe("open");
  });
});
