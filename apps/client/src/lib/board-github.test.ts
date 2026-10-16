import { describe, expect, it } from "vitest";
import {
  issueIndex,
  issueKey,
  landedToday,
  startOfLocalDay,
  suggestedIssues,
} from "@/lib/board-github";
import type { IssueItem, PrItem, TaskItem } from "@/lib/data";

function issue(over: Partial<IssueItem> = {}): IssueItem {
  return {
    repo: "octo/widgets",
    number: 1,
    title: "an issue",
    labels: [],
    assignees: [],
    state: "open",
    url: "u",
    updatedTs: 0,
    dismissedTs: 0,
    ...over,
  };
}

function pr(over: Partial<PrItem> = {}): PrItem {
  return {
    repo: "octo/widgets",
    number: 1,
    title: "a PR",
    branch: "b",
    state: "merged",
    checks: "passing",
    reviewState: "",
    url: "u",
    updatedTs: 0,
    dismissedTs: 0,
    ...over,
  };
}

function task(over: Partial<TaskItem> = {}): TaskItem {
  return {
    id: 1,
    text: "t",
    status: "backlog",
    rank: 0,
    createdAt: 0,
    issues: [],
    prs: [],
    closed: false,
    hasWorktree: false,
    ...over,
  };
}

describe("issueIndex", () => {
  it("keys case-folded and prefers the user's own row over a watched copy", () => {
    const mine = issue({ repo: "Octo/Widgets", number: 7, title: "mine" });
    const watched = issue({ repo: "octo/widgets", number: 7, title: "watched" });
    const index = issueIndex([mine], [watched]);
    expect(index.get(issueKey("octo/widgets", 7))?.title).toBe("mine");
  });
});

describe("suggestedIssues", () => {
  it("drops linked, closed and dismissed issues, newest first", () => {
    const watched = [
      issue({ number: 1, updatedTs: 10 }),
      issue({ number: 2, updatedTs: 30 }),
      issue({ number: 3, updatedTs: 20, state: "closed" }),
      issue({ number: 4, updatedTs: 40, dismissedTs: 40 }),
      issue({ number: 5, updatedTs: 50 }),
    ];
    const linkedByClosedTask = task({
      status: "done",
      closed: true,
      issues: [{ repo: "OCTO/widgets", number: 5, url: "u", state: "open" }],
    });
    expect(suggestedIssues(watched, [linkedByClosedTask]).map((i) => i.number)).toEqual([2, 1]);
  });
});

describe("landedToday", () => {
  const now = new Date(2026, 9, 16, 15, 0).getTime();
  const midnight = startOfLocalDay(now);

  it("counts merged PRs and done tasks since local midnight", () => {
    const landed = landedToday(
      [
        pr({ number: 1, updatedTs: midnight + 1000 }),
        pr({ number: 2, updatedTs: midnight - 1 }),
        pr({ number: 3, updatedTs: midnight + 5000, state: "open" }),
        pr({ number: 4, updatedTs: midnight + 9000 }),
      ],
      [
        task({ id: 1, displayOutcome: "done", completedAt: midnight + 10 }),
        task({ id: 2, displayOutcome: "abandoned", completedAt: midnight + 20 }),
        task({ id: 3, displayOutcome: "done", completedAt: midnight - 10 }),
      ],
      now,
    );
    expect(landed.prs.map((p) => p.number)).toEqual([4, 1]);
    expect(landed.tasks.map((t) => t.id)).toEqual([1]);
  });

  it("starts the day at local midnight", () => {
    expect(new Date(midnight).getHours()).toBe(0);
    expect(midnight).toBeLessThanOrEqual(now);
    expect(now - midnight).toBe(15 * 60 * 60 * 1000);
  });
});
