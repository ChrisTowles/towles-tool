import { describe, expect, it } from "vitest";
import {
  cardPrimary,
  liveCursor,
  moveCursor,
  primaryPr,
  type CursorGrid,
  type CursorMove,
  type CursorTarget,
} from "./board-cursor";
import type { TaskPrLink } from "@/lib/data";

const t = (id: number): CursorTarget => ({ kind: "task", id });
const issue = (key: string): CursorTarget => ({ kind: "issue", key });

// lane A: backlog 1,2 | doing 3 | done -      lane B: backlog - | doing 4,5 | done 6
// lane C: all empty      lane D: backlog 7 | doing - | done 8,9
const grid: CursorGrid = {
  issues: [],
  lanes: [
    [[1, 2], [3], []],
    [[], [4, 5], [6]],
    [[], [], []],
    [[7], [], [8, 9]],
  ],
};

function walk(g: CursorGrid, from: CursorTarget | null, ...moves: CursorMove[]) {
  let at = from;
  for (const m of moves) at = moveCursor(g, at, m);
  return at;
}

describe("moveCursor", () => {
  it("lands on the top of the board when there is no cursor", () => {
    expect(moveCursor(grid, null, "down")).toEqual(t(1));
    expect(moveCursor(grid, null, "left")).toEqual(t(1));
  });

  it("returns null on a board with nothing on it", () => {
    expect(moveCursor({ issues: [], lanes: [] }, null, "down")).toBeNull();
    expect(moveCursor({ issues: [], lanes: [[[], [], []]] }, null, "right")).toBeNull();
  });

  it("steps within a cell and clamps nowhere it can still go", () => {
    expect(walk(grid, t(1), "down")).toEqual(t(2));
    expect(walk(grid, t(2), "up")).toEqual(t(1));
  });

  it("continues down a column into the next lane that has one, skipping empty lanes", () => {
    expect(walk(grid, t(3), "down")).toEqual(t(4));
    expect(walk(grid, t(5), "down")).toEqual(t(5));
  });

  it("walks back up into the previous lane's last card", () => {
    expect(walk(grid, t(4), "up")).toEqual(t(3));
    expect(walk(grid, t(8), "up")).toEqual(t(6));
    expect(walk(grid, t(7), "up")).toEqual(t(2));
  });

  it("clamps at the bottom and top edges", () => {
    expect(walk(grid, t(9), "down")).toEqual(t(9));
    expect(walk(grid, t(1), "up")).toEqual(t(1));
  });

  it("moves between columns of a lane, skipping empty ones, keeping the row", () => {
    expect(walk(grid, t(1), "right")).toEqual(t(3));
    expect(walk(grid, t(2), "right")).toEqual(t(3));
    expect(walk(grid, t(5), "right")).toEqual(t(6));
    expect(walk(grid, t(5), "left")).toEqual(t(5));
    expect(walk(grid, t(8), "left")).toEqual(t(7));
    expect(walk(grid, t(9), "left")).toEqual(t(7));
  });

  it("never wraps sideways into another lane", () => {
    expect(walk(grid, t(3), "right")).toEqual(t(3));
    expect(walk(grid, t(1), "left")).toEqual(t(1));
    expect(walk(grid, t(6), "right")).toEqual(t(6));
  });

  it("carries a card through a filtered view that left a lane with one cell", () => {
    const filtered: CursorGrid = { issues: [], lanes: [[[], [3], []]] };
    expect(walk(filtered, null, "down")).toEqual(t(3));
    expect(walk(filtered, t(3), "right", "left", "up", "down")).toEqual(t(3));
  });
});

describe("moveCursor with watched issues", () => {
  const withIssues: CursorGrid = { ...grid, issues: ["a#1", "a#2"] };

  it("starts on the first issue and walks the list", () => {
    expect(moveCursor(withIssues, null, "down")).toEqual(issue("a#1"));
    expect(walk(withIssues, issue("a#1"), "down")).toEqual(issue("a#2"));
    expect(walk(withIssues, issue("a#1"), "up")).toEqual(issue("a#1"));
  });

  it("drops from the last issue into the first card, and climbs back out", () => {
    expect(walk(withIssues, issue("a#2"), "down")).toEqual(t(1));
    expect(walk(withIssues, t(1), "up")).toEqual(issue("a#2"));
    expect(walk(withIssues, t(3), "up")).toEqual(issue("a#2"));
  });

  it("ignores sideways moves on an issue", () => {
    expect(walk(withIssues, issue("a#1"), "left", "right")).toEqual(issue("a#1"));
  });

  it("stays on the last issue when there are no cards", () => {
    const only: CursorGrid = { issues: ["a#1"], lanes: [] };
    expect(walk(only, issue("a#1"), "down")).toEqual(issue("a#1"));
  });
});

describe("liveCursor", () => {
  it("keeps a cursor that is still on the board", () => {
    expect(liveCursor(grid, t(5))).toEqual(t(5));
  });

  it("drops one that was filtered out, closed away, or folded under its section", () => {
    expect(liveCursor(grid, t(99))).toBeNull();
    expect(liveCursor(grid, issue("a#1"))).toBeNull();
    expect(liveCursor(grid, null)).toBeNull();
  });
});

describe("cardPrimary", () => {
  it("opens a checkout that is on the rail", () => {
    expect(cardPrimary({ closed: false, hasWorktree: true }, true)).toBe("open");
    expect(cardPrimary({ closed: true, hasWorktree: true }, true)).toBe("open");
  });

  it("starts a task with no checkout, or one whose repo isn't on the rail", () => {
    expect(cardPrimary({ closed: false, hasWorktree: false }, true)).toBe("start");
    expect(cardPrimary({ closed: false, hasWorktree: true }, false)).toBe("start");
  });

  it("offers nothing on a closed task with no way in", () => {
    expect(cardPrimary({ closed: true, hasWorktree: false }, true)).toBeNull();
  });
});

const pr = (number: number, state: string): TaskPrLink => ({
  repo: "o/r",
  number,
  url: `https://github.com/o/r/pull/${number}`,
  state,
  checks: "none",
});

describe("primaryPr", () => {
  it("prefers a PR that is still open", () => {
    expect(primaryPr({ prs: [pr(1, "merged"), pr(2, "open")] })?.number).toBe(2);
  });

  it("falls back to the first linked PR", () => {
    expect(primaryPr({ prs: [pr(1, "merged"), pr(2, "closed")] })?.number).toBe(1);
  });

  it("is undefined with no PR", () => {
    expect(primaryPr({ prs: [] })).toBeUndefined();
  });
});
