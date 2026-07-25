import { describe, expect, it } from "vitest";
import { repoForRoot, startTaskNav, type TaskStartPayload } from "@/lib/task-start";
import type { RepoData } from "@/lib/agentboard";

/** A rail repo row with only the fields the routing reads — structural, so the
 * test doesn't have to build a full backend snapshot. */
function repo(over: Partial<RepoData> & Pick<RepoData, "key" | "dir">): RepoData {
  return {
    name: over.dir.split("/").pop() ?? over.dir,
    originUrl: null,
    folders: [],
    ...over,
  } as RepoData;
}

function payload(over: Partial<TaskStartPayload> = {}): TaskStartPayload {
  return {
    taskId: 141,
    repoRoot: "/code/p/tt-rs",
    branch: "fix/thing",
    base: null,
    prompt: "Do the thing.",
    dynamic: false,
    ...over,
  };
}

describe("repoForRoot", () => {
  const repos = [
    repo({
      key: "path:/code/p/tt-rs",
      dir: "/code/p/tt-rs",
      folders: [{ dir: "/code/p/tt-rs" }, { dir: "/code/p/tt-rs/.claude/worktrees/feat-x" }],
    } as Partial<RepoData> & Pick<RepoData, "key" | "dir">),
    repo({ key: "path:/code/p/dawn", dir: "/code/p/dawn" } as Partial<RepoData> &
      Pick<RepoData, "key" | "dir">),
  ];

  it("matches a repo by its own directory", () => {
    expect(repoForRoot(repos, "/code/p/dawn")?.key).toBe("path:/code/p/dawn");
  });

  // A task's bound repoRoot names the checkout its worktree branches from,
  // which for a repo tracked via one of its worktrees is a folder, not the row.
  it("matches a repo by one of its folders", () => {
    expect(repoForRoot(repos, "/code/p/tt-rs/.claude/worktrees/feat-x")?.key).toBe(
      "path:/code/p/tt-rs",
    );
  });

  it("ignores a trailing separator on either side", () => {
    expect(repoForRoot(repos, "/code/p/dawn/")?.key).toBe("path:/code/p/dawn");
  });

  it("returns undefined for an untracked root rather than guessing", () => {
    expect(repoForRoot(repos, "/code/p/elsewhere")).toBeUndefined();
  });
});

describe("startTaskNav", () => {
  const repos = [
    repo({
      key: "path:/code/p/tt-rs",
      dir: "/code/p/tt-rs",
      originUrl: "git@github.com:ChrisTowles/towles-tool-rs.git",
    } as Partial<RepoData> & Pick<RepoData, "key" | "dir">),
  ];

  it("carries the task id, branch and prompt through to the request", () => {
    const nav = startTaskNav(payload({ dynamic: true, base: "develop" }), repos);
    expect(nav).toMatchObject({
      kind: "start-task",
      repoDir: "/code/p/tt-rs",
      repoKey: "path:/code/p/tt-rs",
      taskId: 141,
      goal: "Do the thing.",
      branch: "fix/thing",
      base: "develop",
      dynamic: true,
    });
  });

  // The backend sends `null` for an absent base (serde `Option`); the form's
  // "default branch" case is `undefined`, so it has to be normalized.
  it("normalizes a null base to undefined", () => {
    expect(startTaskNav(payload({ base: null }), repos)?.base).toBeUndefined();
  });

  it("returns undefined when the payload's repo isn't tracked", () => {
    expect(startTaskNav(payload({ repoRoot: "/nope" }), repos)).toBeUndefined();
  });
});
