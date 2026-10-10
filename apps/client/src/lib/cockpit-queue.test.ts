import { describe, expect, it } from "vitest";
import type { FolderData, NeedsReason, RepoData, SessionData } from "@/lib/agentboard";
import { buildWorkQueue, cycleQueue } from "@/lib/cockpit-queue";
import type { PrItem } from "@/lib/data";

function session(id: string, needsReason: NeedsReason | null, needsSinceMs?: number): SessionData {
  return {
    id,
    name: `shell ${id}`,
    createdAt: 0,
    live: true,
    unseen: false,
    working: needsReason === null,
    agents: [],
    needsReason,
    needsSinceMs,
  };
}

function folder(overrides: Partial<FolderData>): FolderData {
  return {
    name: "proj",
    dir: "/code/proj",
    repoRoot: "/code/proj",
    record: { origin: "checkout" },
    dirMissing: false,
    branch: "main",
    isWorktree: false,
    committedFiles: 0,
    committedAdded: 0,
    committedRemoved: 0,
    uncommittedFiles: 0,
    uncommittedAdded: 0,
    uncommittedRemoved: 0,
    uncommittedCapped: false,
    stagedFiles: 0,
    stagedAdded: 0,
    stagedRemoved: 0,
    commitsAhead: 0,
    commitsBehind: 0,
    dirty: false,
    commitsUnlanded: 0,
    landed: null,
    sessions: [],
    needs: 0,
    hasPortDrift: false,
    hasLaunchConfig: false,
    quiet: false,
    ...overrides,
  };
}

function repo(folders: FolderData[]): RepoData {
  return {
    key: "proj",
    dir: "/code/proj",
    name: "proj",
    originUrl: "git@github.com:me/proj.git",
    folders,
    needs: 0,
  };
}

const mergedPr = { repo: "me/proj", number: 7, branch: "feat-x", state: "merged", updatedTs: 50 };

describe("buildWorkQueue", () => {
  it("orders by reason, then oldest first, and skips working sessions", () => {
    const queue = buildWorkQueue(
      [
        repo([
          folder({
            sessions: [
              session("fin", "finished", 10),
              session("busy", null),
              session("wait-new", "waitingForInput", 300),
              session("wait-old", "waitingForInput", 100),
              session("err", "errored", 500),
            ],
          }),
        ]),
      ],
      [],
    );
    expect(queue.map((i) => i.id)).toEqual([
      "session:err",
      "session:wait-old",
      "session:wait-new",
      "session:fin",
    ]);
    expect(queue[0].repo).toBe("me/proj");
  });

  it("queues a landed, clean worktree for cleanup after every session", () => {
    const queue = buildWorkQueue(
      [
        repo([
          folder({ sessions: [session("fin", "finished", 900)] }),
          folder({ name: "tt-feat-x", dir: "/code/proj-x", branch: "feat-x", isWorktree: true }),
          folder({
            name: "tt-dirty",
            dir: "/code/proj-d",
            branch: "feat-x",
            isWorktree: true,
            dirty: true,
          }),
        ]),
      ],
      [mergedPr as PrItem],
    );
    expect(queue.map((i) => i.id)).toEqual(["session:fin", "cleanup:/code/proj-x"]);
    expect(queue[1].sessionId).toBeUndefined();
  });
});

describe("cycleQueue", () => {
  const queue = buildWorkQueue(
    [
      repo([
        folder({
          sessions: [session("a", "errored", 1), session("b", "waitingForInput", 2)],
        }),
        folder({ name: "tt-feat-x", dir: "/code/proj-x", branch: "feat-x", isWorktree: true }),
      ]),
    ],
    [mergedPr as PrItem],
  );

  it("starts at the head and walks sessions in queue order, wrapping", () => {
    expect(cycleQueue(queue, null, "next")).toBe("a");
    expect(cycleQueue(queue, "a", "next")).toBe("b");
    expect(cycleQueue(queue, "b", "next")).toBe("a");
    expect(cycleQueue(queue, "a", "prev")).toBe("b");
  });

  it("restarts from the head when the current session was just answered", () => {
    expect(cycleQueue(queue, "answered", "next")).toBe("a");
  });

  it("is null when only cleanup rows remain", () => {
    expect(cycleQueue(queue.slice(2), null, "next")).toBeNull();
  });
});
