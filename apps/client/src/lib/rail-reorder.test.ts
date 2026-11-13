import { describe, expect, it } from "vitest";
import type { FolderData } from "@/lib/agentboard/types";
import { repoDropOrder, repoStepOrder, taskDropMove, taskStepMove } from "./rail-reorder";

const root = { dir: "/r", record: { origin: "checkout" } } as FolderData;
const task = (id: number) =>
  ({
    dir: `/r/wt/${id}`,
    record: { origin: "task", task: { id, status: "doing" } },
  }) as FolderData;
const FOLDERS = [root, task(1), task(2), task(3)];

describe("taskStepMove", () => {
  it("steps over the root checkout, which never moves", () => {
    expect(taskStepMove(FOLDERS, "/r/wt/1", "up")).toBeNull();
    expect(taskStepMove(FOLDERS, "/r", "down")).toBeNull();
  });

  it("moves before the row above and after the row below", () => {
    expect(taskStepMove(FOLDERS, "/r/wt/2", "up")).toEqual({ id: 2, to: { before: 1 } });
    expect(taskStepMove(FOLDERS, "/r/wt/2", "down")).toEqual({ id: 2, to: { after: 3 } });
    expect(taskStepMove(FOLDERS, "/r/wt/3", "down")).toBeNull();
  });
});

describe("taskDropMove", () => {
  it("takes the target's place from either side", () => {
    expect(taskDropMove(FOLDERS, "/r/wt/3", "/r/wt/1")).toEqual({ id: 3, to: { before: 1 } });
    expect(taskDropMove(FOLDERS, "/r/wt/1", "/r/wt/3")).toEqual({ id: 1, to: { after: 3 } });
  });

  it("ignores a drop on itself or on a row no task owns", () => {
    expect(taskDropMove(FOLDERS, "/r/wt/1", "/r/wt/1")).toBeNull();
    expect(taskDropMove(FOLDERS, "/r/wt/1", "/r")).toBeNull();
  });
});

describe("repo order", () => {
  const DIRS = ["/a", "/b", "/c"];

  it("steps one place and stops at the ends", () => {
    expect(repoStepOrder(DIRS, "/b", "up")).toEqual(["/b", "/a", "/c"]);
    expect(repoStepOrder(DIRS, "/b", "down")).toEqual(["/a", "/c", "/b"]);
    expect(repoStepOrder(DIRS, "/a", "up")).toBeNull();
    expect(repoStepOrder(DIRS, "/c", "down")).toBeNull();
  });

  it("drops into the target's place", () => {
    expect(repoDropOrder(DIRS, "/c", "/a")).toEqual(["/c", "/a", "/b"]);
    expect(repoDropOrder(DIRS, "/a", "/c")).toEqual(["/b", "/c", "/a"]);
    expect(repoDropOrder(DIRS, "/a", "/a")).toBeNull();
  });
});
