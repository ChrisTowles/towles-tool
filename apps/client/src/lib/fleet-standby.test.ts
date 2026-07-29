import { describe, expect, it } from "vitest";
import { buildStandby } from "@/lib/fleet-standby";
import type { AgentStatus, FolderData, RepoData, SessionData } from "@/lib/agentboard";

const NOW = 100 * 60 * 60_000;

function session(overrides: Partial<SessionData>): SessionData {
  return {
    id: "s1",
    name: "shell 1",
    createdAt: 0,
    live: false,
    unseen: false,
    agents: [],
    ...overrides,
  };
}

function agent(status: AgentStatus, threadName?: string) {
  return { agent: "claude-code", session: "", status, ts: 1, threadName };
}

function folder(overrides: Partial<FolderData>): FolderData {
  return {
    name: "proj",
    dir: "/code/proj",
    dirMissing: false,
    branch: "main",
    isWorktree: false,
    committedFiles: 0,
    committedAdded: 0,
    committedRemoved: 0,
    uncommittedFiles: 0,
    uncommittedAdded: 0,
    uncommittedRemoved: 0,
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

function repo(name: string, folders: FolderData[]): RepoData {
  return { key: name, dir: `/code/${name}`, name, folders, needs: 0 };
}

/** A checkout whose agent is blocked, waiting since `since`. */
function blocked(name: string, since: number, extra: Partial<SessionData> = {}): FolderData {
  return folder({
    name,
    dir: `/code/${name}`,
    isWorktree: true,
    sessions: [
      session({
        id: name,
        live: true,
        agentState: agent("waiting"),
        needsSinceMs: since,
        ...extra,
      }),
    ],
  });
}

describe("buildStandby", () => {
  it("rows are blocked agents only, longest wait first; held work is counted", () => {
    const board = buildStandby(
      [
        repo("alpha", [
          folder({ name: "held", dir: "/code/held", uncommittedFiles: 3, dirty: true }),
          blocked("recent", NOW - 60_000),
        ]),
        repo("beta", [blocked("stale", NOW - 20 * 60_000)]),
      ],
      NOW,
    );
    expect(board.rows.map((r) => r.title)).toEqual(["Stale", "Recent"]);
    expect(board.holding).toBe(1);
  });

  it("puts two blocked agents from different repos next to each other", () => {
    // The whole reason this view exists — the rail groups by repo and can never
    // do this.
    const board = buildStandby(
      [
        repo("alpha", [blocked("a", NOW - 5 * 60_000), folder({ name: "quiet-a", dir: "/qa" })]),
        repo("beta", [blocked("b", NOW - 9 * 60_000), folder({ name: "quiet-b", dir: "/qb" })]),
      ],
      NOW,
    );
    expect(board.rows.map((r) => r.title)).toEqual(["B", "A"]);
    expect(board.total).toBe(4);
  });

  it("counts a busy agent instead of giving it a row", () => {
    const board = buildStandby(
      [
        repo("alpha", [
          folder({
            name: "running",
            dir: "/r",
            sessions: [session({ live: true, agentState: agent("busy") })],
          }),
        ]),
      ],
      NOW,
    );
    expect(board.rows).toEqual([]);
    expect(board.working).toBe(1);
  });

  it("an errored agent reads as errored, not as a wait", () => {
    const board = buildStandby(
      [
        repo("alpha", [
          folder({
            name: "broke",
            dir: "/b",
            sessions: [session({ live: true, agentState: agent("error"), needsSinceMs: NOW })],
          }),
        ]),
      ],
      NOW,
    );
    expect(board.rows[0].note).toBe("errored");
  });

  it("counts landed and held checkouts without giving either a row", () => {
    const board = buildStandby(
      [
        repo("alpha", [
          folder({ name: "done", dir: "/d", landed: "squash-merged" }),
          folder({ name: "wip", dir: "/w", commitsUnlanded: 2 }),
        ]),
      ],
      NOW,
    );
    expect(board.rows).toEqual([]);
    expect(board.landed).toBe(1);
    expect(board.holding).toBe(1);
  });

  it("a landed branch still holding work counts as held, not removable", () => {
    const board = buildStandby(
      [
        repo("a", [
          folder({ name: "x", dir: "/x", landed: "merged", dirty: true, uncommittedFiles: 1 }),
        ]),
      ],
      NOW,
    );
    expect(board.landed).toBe(0);
    expect(board.holding).toBe(1);
  });

  it("quotes the agent's own words, freshest source first", () => {
    const thread = buildStandby(
      [repo("a", [blocked("x", NOW, { agentState: agent("waiting", "a thread"), purpose: "p" })])],
      NOW,
    );
    expect(thread.rows[0].said).toBe("a thread");

    const purpose = buildStandby([repo("a", [blocked("x", NOW, { purpose: "the prompt" })])], NOW);
    expect(purpose.rows[0].said).toBe("the prompt");

    const silent = buildStandby([repo("a", [blocked("x", NOW)])], NOW);
    expect(silent.rows[0].said).toBeNull();
  });

  it("the generic Claude Code title is not something it said", () => {
    const board = buildStandby(
      [repo("a", [blocked("x", NOW, { agentState: agent("waiting", "Claude Code") })])],
      NOW,
    );
    expect(board.rows[0].said).toBeNull();
  });

  it("a whole-quiet fleet produces no rows and names where you last worked", () => {
    const board = buildStandby(
      [
        repo("alpha", [
          folder({ name: "old", dir: "/o", isWorktree: true, workedAtMs: NOW - 5 * 60 * 60_000 }),
          folder({ name: "newer", dir: "/n", isWorktree: true, workedAtMs: NOW - 40 * 60_000 }),
        ]),
      ],
      NOW,
    );
    expect(board.rows).toEqual([]);
    expect(board.lastWorkedName).toBe("Newer");
    expect(board.lastWorkedAt).toBe(NOW - 40 * 60_000);
  });

  it("ghost checkouts count toward nothing", () => {
    const board = buildStandby(
      [repo("a", [folder({ name: "gone", dir: "/g", dirMissing: true, uncommittedFiles: 4 })])],
      NOW,
    );
    expect(board.rows).toEqual([]);
    expect(board.total).toBe(0);
  });

  it("de-slugs a worktree title and names its repo, rather than restating the branch", () => {
    const board = buildStandby([repo("towles-tool", [blocked("feat-more-cleanup", NOW)])], NOW);
    expect(board.rows[0]).toMatchObject({ repo: "towles-tool", title: "More cleanup" });
  });

  it("a repo's main checkout is titled Root, the way the rail names it", () => {
    const board = buildStandby(
      [repo("toolbox", [{ ...blocked("toolbox", NOW), isWorktree: false }])],
      NOW,
    );
    expect(board.rows[0].title).toBe("Root");
  });
});
