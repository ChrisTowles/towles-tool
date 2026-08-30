import { describe, expect, it } from "vitest";
import { buildJumpRecall } from "@/lib/jump-recall";
import type { AgentStatus, FolderData, RepoData, SessionData } from "@/lib/agentboard";

const NOW = 100 * 60 * 60_000;

function session(overrides: Partial<SessionData>): SessionData {
  return {
    id: "s1",
    name: "shell 1",
    createdAt: 0,
    live: true,
    unseen: false,
    agents: [],
    ...overrides,
  };
}

function agent(status: AgentStatus, threadName?: string) {
  return { agent: "claude-code", session: "", status, ts: 1, threadName };
}

function folder(overrides: Partial<FolderData>): FolderData {
  const row: FolderData = {
    name: "feat-agent-switch",
    dir: "/code/proj/.claude/worktrees/feat-agent-switch",
    repoRoot: "/code/proj",
    record: { origin: "checkout" },
    dirMissing: false,
    branch: "feat/agent-switch",
    isWorktree: true,
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
  };
  return { ...row, ...overrides };
}

function repos(f: FolderData): RepoData[] {
  return [{ key: "proj", dir: "/code/proj", name: "proj", folders: [f], needs: 0 }];
}

describe("buildJumpRecall", () => {
  it("names the checkout and repeats what the agent said", () => {
    const f = folder({});
    const r = buildJumpRecall(
      repos(f),
      f,
      session({ agentState: agent("waiting", "Wire the recall card") }),
      NOW,
      3,
    );
    expect(r.title).toBe("Agent switch");
    expect(r.repo).toBe("proj");
    expect(r.branch).toBe("feat/agent-switch");
    expect(r.said).toBe("Wire the recall card");
    expect(r.nonce).toBe(3);
  });

  it("falls back to the launch prompt, and to nothing when it never spoke", () => {
    const f = folder({});
    expect(buildJumpRecall(repos(f), f, session({ purpose: "ship it" }), NOW, 1).said).toBe(
      "ship it",
    );
    expect(buildJumpRecall(repos(f), f, session({}), NOW, 1).said).toBeNull();
  });

  it("reports the wait, and calls an errored session errored instead", () => {
    const f = folder({});
    const waiting = buildJumpRecall(
      repos(f),
      f,
      session({ needsSinceMs: NOW - 12 * 60_000, agentState: agent("waiting") }),
      NOW,
      1,
    );
    expect(waiting.waiting).toBe("waiting 12m");
    expect(waiting.errored).toBe(false);

    const errored = buildJumpRecall(
      repos(f),
      f,
      session({ needsSinceMs: NOW - 12 * 60_000, agentState: agent("error") }),
      NOW,
      1,
    );
    expect(errored.waiting).toBe("errored");
    expect(errored.errored).toBe(true);
  });

  it("summarizes work that exists nowhere else, and stays quiet when clean", () => {
    const dirty = folder({ uncommittedFiles: 4, uncommittedCapped: true, commitsAhead: 2 });
    expect(buildJumpRecall(repos(dirty), dirty, session({}), NOW, 1).work).toBe(
      "4+ uncommitted · 2 ahead",
    );
    const clean = folder({});
    expect(buildJumpRecall(repos(clean), clean, session({}), NOW, 1).work).toBeNull();
  });

  it("dates the checkout, and says nothing when it was never worked", () => {
    const worked = folder({ workedAtMs: NOW - 3 * 60 * 60_000 });
    expect(buildJumpRecall(repos(worked), worked, session({}), NOW, 1).lastWorked).toBe("3h ago");
    const fresh = folder({});
    expect(buildJumpRecall(repos(fresh), fresh, session({}), NOW, 1).lastWorked).toBeNull();
  });

  it("calls the main checkout Root", () => {
    const main = folder({ name: "proj", isWorktree: false, dir: "/code/proj" });
    expect(buildJumpRecall(repos(main), main, session({}), NOW, 1).title).toBe("Root");
  });
});
