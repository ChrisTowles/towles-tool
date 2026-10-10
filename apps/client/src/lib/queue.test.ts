import { describe, expect, it } from "vitest";
import {
  cycleQueue,
  itemUrl,
  keyId,
  nextItem,
  nextUpArrival,
  onYouHead,
  primaryAction,
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
    ci: [],
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

describe("PR and CI rows", () => {
  const pr = item(9, {
    key: { kind: "pr", repo: "o/r", number: 7 },
    folderDir: null,
    sessionId: null,
    reason: "review_pr",
    pr: { repo: "o/r", number: 7, url: "pr-url", state: "open", checks: "", reviewState: "" },
  });
  const ci = item(10, {
    key: { kind: "ci", repo: "o/r", branch: "main" },
    folderDir: null,
    sessionId: null,
    reason: "fix_ci",
    ci: [{ workflow: "Nightly", url: "run-url", conclusion: "failure", updatedMs: 1 }],
  });
  it("open on GitHub and key distinctly", () => {
    expect(primaryAction(pr)).toBe("open-link");
    expect(itemUrl(pr)).toBe("pr-url");
    expect(itemUrl(ci)).toBe("run-url");
    expect(keyId(pr.key)).toBe("pr:o/r#7");
    expect(keyId(ci.key)).toBe("ci:o/r@main");
    expect(TaskQueueSchema.parse(queue([pr, ci])).items).toHaveLength(2);
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

describe("rail rows", () => {
  const q = queue([item(1), item(2, { lane: "running" }), item(3, { lane: "backlog" })]);
  it("skip folded lanes and find a checkout's row", () => {
    expect(railRows(q, new Set(["running"])).map((i) => i.title)).toEqual(["t1", "t3"]);
    expect(rowForFolder(q, "/w2")?.title).toBe("t2");
    expect(rowForFolder(q, null)).toBeUndefined();
    expect(onYouHead(q)?.title).toBe("t1");
  });
  it("step within bounds, from nothing to the first", () => {
    const rows = railRows(q, new Set());
    expect(stepRow(rows, null, 1)?.title).toBe("t1");
    expect(stepRow(rows, "task:1", 1)?.title).toBe("t2");
    expect(stepRow(rows, "task:3", 1)?.title).toBe("t3");
    expect(stepRow(rows, "task:1", -1)?.title).toBe("t1");
    expect(stepRow([], null, 1)).toBeUndefined();
  });
});

describe("nextUpArrival", () => {
  const head = item(2);
  const idle = { terminalFocused: false, selectedKey: null, selectedOnYou: false };
  it("opens on first sight only when nothing is selected or typed in", () => {
    expect(nextUpArrival(undefined, head, idle)).toBe("open");
    expect(nextUpArrival(undefined, head, { ...idle, terminalFocused: true })).toBeNull();
    expect(nextUpArrival(undefined, head, { ...idle, selectedKey: "task:9" })).toBeNull();
  });
  it("ignores an unchanged head or one already on screen", () => {
    expect(nextUpArrival("task:2", head, idle)).toBeNull();
    expect(nextUpArrival("task:1", head, { ...idle, selectedKey: "task:2" })).toBeNull();
    expect(nextUpArrival("task:1", undefined, idle)).toBeNull();
  });
  it("never takes a focused terminal or a row that still needs you", () => {
    expect(nextUpArrival("task:1", head, { ...idle, terminalFocused: true })).toBe("announce");
    const busy = { ...idle, selectedKey: "task:1", selectedOnYou: true };
    expect(nextUpArrival("task:1", head, busy)).toBe("announce");
  });
  it("opens once you're done with what you had open", () => {
    const answered = { ...idle, selectedKey: "task:1", selectedOnYou: false };
    expect(nextUpArrival("task:1", head, answered)).toBe("open");
    expect(nextUpArrival("task:1", head, idle)).toBe("open");
  });
});
