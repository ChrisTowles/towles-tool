/** The Board's keyboard cursor, as a pure walk over what is on screen: the
 * watched-issue rows, then the swimlanes' status columns. Targets are ids, not
 * positions, so a snapshot that reorders cards never moves the ring. */
import type { TaskItem, TaskPrLink } from "@/lib/data";

export type CursorTarget = { kind: "issue"; key: string } | { kind: "task"; id: number };

/** `lanes[lane][column]` holds the task ids of one cell, top to bottom. */
export type CursorGrid = { issues: string[]; lanes: number[][][] };

export type CursorMove = "up" | "down" | "left" | "right";

type Spot =
  | { kind: "issue"; at: number }
  | { kind: "task"; lane: number; col: number; row: number };

function locate(grid: CursorGrid, target: CursorTarget): Spot | null {
  if (target.kind === "issue") {
    const at = grid.issues.indexOf(target.key);
    return at < 0 ? null : { kind: "issue", at };
  }
  for (const [lane, cols] of grid.lanes.entries()) {
    for (const [col, ids] of cols.entries()) {
      const row = ids.indexOf(target.id);
      if (row >= 0) return { kind: "task", lane, col, row };
    }
  }
  return null;
}

function targetAt(grid: CursorGrid, spot: Spot): CursorTarget {
  if (spot.kind === "issue") return { kind: "issue", key: grid.issues[spot.at]! };
  return { kind: "task", id: grid.lanes[spot.lane]![spot.col]![spot.row]! };
}

/** A cursor that no longer points at anything on screen (filtered out, closed,
 * the watched list folded) reads as no cursor. */
export function liveCursor(grid: CursorGrid, target: CursorTarget | null): CursorTarget | null {
  return target && locate(grid, target) ? target : null;
}

/** Top-left of the board in reading order. */
function first(grid: CursorGrid): Spot | null {
  if (grid.issues.length > 0) return { kind: "issue", at: 0 };
  return firstTask(grid);
}

function firstTask(grid: CursorGrid): Spot | null {
  for (const [lane, cols] of grid.lanes.entries()) {
    const col = cols.findIndex((ids) => ids.length > 0);
    if (col >= 0) return { kind: "task", lane, col, row: 0 };
  }
  return null;
}

function cellSize(grid: CursorGrid, lane: number, col: number): number {
  return grid.lanes[lane]?.[col]?.length ?? 0;
}

function step(grid: CursorGrid, from: Spot, move: CursorMove): Spot {
  if (from.kind === "issue") {
    if (move === "up") return { kind: "issue", at: Math.max(0, from.at - 1) };
    if (move !== "down") return from;
    return from.at + 1 < grid.issues.length
      ? { kind: "issue", at: from.at + 1 }
      : (firstTask(grid) ?? from);
  }
  const { lane, col, row } = from;
  if (move === "down" || move === "up") {
    const dir = move === "down" ? 1 : -1;
    if (row + dir >= 0 && row + dir < cellSize(grid, lane, col)) return { ...from, row: row + dir };
    // Past the cell's end, keep the column and take the next lane that has one.
    for (let l = lane + dir; l >= 0 && l < grid.lanes.length; l += dir) {
      const size = cellSize(grid, l, col);
      if (size > 0) return { kind: "task", lane: l, col, row: dir === 1 ? 0 : size - 1 };
    }
    if (move === "up" && grid.issues.length > 0) {
      return { kind: "issue", at: grid.issues.length - 1 };
    }
    return from;
  }
  // Sideways stays in the lane, skips empty columns, and keeps the row where
  // the new cell is that tall.
  const dir = move === "right" ? 1 : -1;
  for (let c = col + dir; c >= 0 && c < (grid.lanes[lane]?.length ?? 0); c += dir) {
    const size = cellSize(grid, lane, c);
    if (size > 0) return { kind: "task", lane, col: c, row: Math.min(row, size - 1) };
  }
  return from;
}

/** One keypress. With no live cursor any move lands on the top of the board. */
export function moveCursor(
  grid: CursorGrid,
  target: CursorTarget | null,
  move: CursorMove,
): CursorTarget | null {
  const from = target ? locate(grid, target) : null;
  const to = from ? step(grid, from, move) : first(grid);
  return to ? targetAt(grid, to) : null;
}

/** What the card's identity button does, and so what Enter and `s` do: open the
 * task's checkout on the Agentboard, or start a worktree for it. Closed tasks
 * and ones whose repo isn't on the rail offer neither. */
export function cardPrimary(
  task: Pick<TaskItem, "closed" | "hasWorktree">,
  onRail: boolean,
): "open" | "start" | null {
  if (task.hasWorktree && onRail) return "open";
  return task.closed ? null : "start";
}

/** The PR chip `o` opens: the first still-open one, else the first linked. */
export function primaryPr(task: Pick<TaskItem, "prs">): TaskPrLink | undefined {
  return task.prs.find((p) => p.state === "open") ?? task.prs[0];
}
