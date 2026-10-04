import { describe, expect, it } from "vitest";
import type { TaskItem } from "./data";
import { paletteFilter } from "./palette";
import { paletteTaskEntries, paletteTaskTarget } from "./palette-tasks";

function task(overrides: Partial<TaskItem>): TaskItem {
  return {
    id: 1,
    text: "ship the palette",
    status: "backlog",
    position: 0,
    createdAt: 0,
    issues: [],
    prs: [],
    closed: false,
    hasWorktree: false,
    ...overrides,
  };
}

const bound = task({
  id: 7,
  text: "jump to a task",
  status: "doing",
  hasWorktree: true,
  worktree: {
    repoRoot: "/home/me/code/p/widgets",
    repo: "octo/widgets",
    branch: "feat/palette",
    dir: "/home/me/code/p/widgets/.claude/worktrees/feat-palette",
  },
  issues: [{ repo: "octo/widgets", number: 118, url: "u", state: "open" }],
  prs: [{ repo: "octo/widgets", number: 43, url: "u", state: "open", checks: "passing" }],
});

describe("paletteTaskEntries", () => {
  it("drops archived and closed tasks", () => {
    const entries = paletteTaskEntries([
      task({ id: 1 }),
      task({ id: 2, archivedAt: 5 }),
      task({ id: 3, closed: true, status: "done" }),
      task({ id: 4, closed: true, outcome: "abandoned" }),
    ]);
    expect(entries.map((e) => e.id)).toEqual([1]);
  });

  it("leads with in-progress work, then board order within a column", () => {
    const entries = paletteTaskEntries([
      task({ id: 1, status: "backlog", position: 2 }),
      task({ id: 2, status: "doing", position: 9 }),
      task({ id: 3, status: "backlog", position: 1 }),
      task({ id: 4, status: "doing", position: 3 }),
    ]);
    expect(entries.map((e) => e.id)).toEqual([4, 2, 3, 1]);
  });

  it("carries title, repo, branch and a muted meta line", () => {
    const [entry] = paletteTaskEntries([bound]);
    expect(entry.key).toBe("task:7");
    expect(entry.title).toBe("jump to a task");
    expect(entry.repo).toBe("octo/widgets");
    expect(entry.branch).toBe("feat/palette");
    expect(entry.meta).toBe("widgets · feat/palette");
    expect(entry.value).toBe("task 7 jump to a task octo/widgets feat/palette");
  });

  it("keys two same-titled quick todos on distinct values", () => {
    const [a, b] = paletteTaskEntries([
      task({ id: 11, text: "fix tests" }),
      task({ id: 12, text: "fix tests", position: 1 }),
    ]);
    expect(a.value).not.toBe(b.value);
    expect(a.value).toContain(" 11 ");
    expect(b.value).toContain(" 12 ");
  });

  it("makes repo, short name, branch and linked numbers searchable", () => {
    const [entry] = paletteTaskEntries([bound]);
    expect(entry.keywords).toEqual([
      "task",
      "board",
      "octo/widgets",
      "widgets",
      "feat/palette",
      "#118",
      "#43",
    ]);
    const value = `task ${entry.title} ${entry.repo} ${entry.branch}`;
    expect(paletteFilter(value, "43", entry.keywords)).toBeGreaterThan(0);
    expect(paletteFilter(value, "feat/palette", entry.keywords)).toBeGreaterThan(0);
    expect(paletteFilter(value, "gizmos", entry.keywords)).toBe(0);
  });

  it("falls back to a linked issue's repo and leaves meta empty with no identity", () => {
    const [linked, bare] = paletteTaskEntries([
      task({ id: 1, issues: [{ repo: "octo/gizmos", number: 2, url: "u", state: "open" }] }),
      task({ id: 2 }),
    ]);
    expect(linked.repo).toBe("octo/gizmos");
    expect(linked.meta).toBe("gizmos");
    expect(bare.repo).toBeNull();
    expect(bare.branch).toBeNull();
    expect(bare.meta).toBe("");
    expect(bare.keywords).toEqual(["task", "board"]);
  });
});

describe("paletteTaskTarget", () => {
  it("lands on the bound checkout when a worktree is live", () => {
    expect(paletteTaskTarget(bound)).toEqual({
      kind: "worktree",
      folderDir: "/home/me/code/p/widgets/.claude/worktrees/feat-palette",
    });
  });

  it("lands on the Board card without a live worktree, even if a dir is recorded", () => {
    expect(paletteTaskTarget(task({ id: 3 }))).toEqual({ kind: "board", taskId: 3 });
    expect(paletteTaskTarget({ ...bound, hasWorktree: false })).toEqual({
      kind: "board",
      taskId: 7,
    });
    expect(
      paletteTaskTarget({ ...bound, worktree: { ...bound.worktree!, dir: undefined } }),
    ).toEqual({ kind: "board", taskId: 7 });
  });
});
