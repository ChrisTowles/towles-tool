import { describe, expect, it } from "vitest";
import {
  cycleQueue,
  nextItem,
  primaryAction,
  rankMove,
  snoozeUntil,
  tomorrowMorning,
} from "./queue";
import { TaskQueueSchema, type QueueItem, type TaskQueue } from "./schemas/queue";

function item(id: number, over: Partial<QueueItem> = {}): QueueItem {
  return {
    key: { kind: "task", id },
    lane: "on_you",
    reason: "answer",
    also: [],
    title: `t${id}`,
    goal: null,
    repo: "o/r",
    branch: null,
    folderDir: `/w${id}`,
    sessionId: `s${id}`,
    said: null,
    runningAgents: 0,
    pr: null,
    rank: id * 1024,
    sinceMs: null,
    snoozedUntilMs: null,
    snoozed: false,
    ...over,
  };
}

const queue = (items: QueueItem[]): TaskQueue => ({ next: items[0]?.key ?? null, items });

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

describe("primaryAction", () => {
  it("opens a session, else the folder, else starts", () => {
    expect(primaryAction(item(1))).toBe("open-session");
    expect(primaryAction(item(1, { sessionId: null }))).toBe("open-folder");
    expect(primaryAction(item(1, { sessionId: null, folderDir: null, reason: "start" }))).toBe(
      "start",
    );
  });
});

describe("rankMove", () => {
  const items = [item(1), item(2), item(3)];
  it("moves before/after the neighbouring task, or to the top", () => {
    expect(rankMove(items, 1, "up")).toEqual({ before: 1 });
    expect(rankMove(items, 1, "down")).toEqual({ after: 3 });
    expect(rankMove(items, 2, "top")).toBe("top");
  });
  it("declines past either end and for unfiled rows", () => {
    expect(rankMove(items, 0, "up")).toBeNull();
    expect(rankMove(items, 2, "down")).toBeNull();
    const unfiled = item(4, { key: { kind: "unfiled", folderDir: "/x" } });
    expect(rankMove([...items, unfiled], 3, "up")).toBeNull();
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
    const raw = {
      next: { kind: "unfiled", folderDir: "/x" },
      items: [item(1), item(2, { key: { kind: "unfiled", folderDir: "/x" } })],
    };
    const parsed = TaskQueueSchema.parse(raw);
    expect(nextItem(parsed)?.title).toBe("t2");
  });
});
