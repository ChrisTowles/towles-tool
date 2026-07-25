import { describe, expect, it } from "vitest";
import { taskRollup } from "./board-rollup";
import type { TaskItem, TaskIssueLink, TaskPrLink } from "./data";

function task(partial: Pick<TaskItem, "status"> & Partial<TaskItem>): TaskItem {
  return {
    id: 1,
    text: "t",
    position: 0,
    createdAt: 0,
    issues: [],
    prs: [],
    closed: partial.status === "done" || partial.outcome !== undefined,
    hasWorktree: partial.worktree?.dir !== undefined,
    ...partial,
  };
}

function issue(number: number, state: string): TaskIssueLink {
  return { repo: "o/r", number, url: `https://gh/o/r/issues/${number}`, state };
}

function pr(number: number, state: string): TaskPrLink {
  return { repo: "o/r", number, url: `https://gh/o/r/pull/${number}`, state, checks: "none" };
}

describe("taskRollup", () => {
  it("names the merged PR that rolled the card up", () => {
    const rollup = taskRollup(task({ status: "done", prs: [pr(496, "merged")] }));
    expect(rollup?.summary).toBe("PR #496 merged");
    expect(rollup?.evidence).toEqual([
      { kind: "pr", ref: "PR #496", qualified: "o/r#496", state: "merged" },
    ]);
  });

  it("lists issues before PRs, matching the card's chip order", () => {
    const rollup = taskRollup(
      task({ status: "done", issues: [issue(339, "closed")], prs: [pr(496, "merged")] }),
    );
    expect(rollup?.summary).toBe("#339 closed · PR #496 merged");
  });

  it("counts instead of naming once there are more than three links", () => {
    const rollup = taskRollup(
      task({
        status: "done",
        issues: [issue(1, "closed"), issue(2, "closed")],
        prs: [pr(3, "merged"), pr(4, "merged"), pr(5, "closed")],
      }),
    );
    expect(rollup?.summary).toBe("2 PRs merged · 1 PR closed · 2 issues closed");
  });

  it("counts a closed PR as resolved — the rollup's own guard does", () => {
    expect(taskRollup(task({ status: "done", prs: [pr(7, "closed")] }))?.summary).toBe(
      "PR #7 closed",
    );
  });

  it("says nothing for a card the user closed by hand", () => {
    expect(
      taskRollup(task({ status: "done", outcome: "done", prs: [pr(496, "merged")] })),
    ).toBeNull();
  });

  it("says nothing for an abandoned card", () => {
    expect(
      taskRollup(task({ status: "done", outcome: "abandoned", prs: [pr(496, "merged")] })),
    ).toBeNull();
  });

  it("says nothing for a done card with no links", () => {
    expect(taskRollup(task({ status: "done" }))).toBeNull();
  });

  it("says nothing while a link is still open — the rollup couldn't have fired", () => {
    expect(
      taskRollup(task({ status: "done", prs: [pr(496, "merged"), pr(497, "open")] })),
    ).toBeNull();
    expect(
      taskRollup(task({ status: "done", issues: [issue(339, "open")], prs: [pr(496, "merged")] })),
    ).toBeNull();
  });

  it("says nothing for a card that isn't done", () => {
    expect(taskRollup(task({ status: "doing", prs: [pr(496, "merged")] }))).toBeNull();
  });
});
