import { describe, expect, it } from "vitest";
import type { AgentStatus, SessionData } from "@/lib/agentboard";
import { boardAgentStatus, mostUrgentSession } from "@/lib/board-agent-status";

function session(id: string, overrides: Partial<SessionData> = {}): SessionData {
  return {
    id,
    name: id,
    createdAt: 0,
    live: true,
    unseen: false,
    working: false,
    agents: [],
    ...overrides,
  };
}

function agent(status: AgentStatus): SessionData["agentState"] {
  return { agent: "claude-code", session: "", status, ts: 1 };
}

const repos = (folders: { dir: string; sessions: SessionData[] }[]) => [{ folders }];

describe("boardAgentStatus", () => {
  it("joins a task's worktree dir to the rail folder with that dir", () => {
    const s = session("a", { agentState: agent("busy"), working: true });
    const state = repos([
      { dir: "/code/x", sessions: [] },
      { dir: "/code/x/.claude/worktrees/t", sessions: [s] },
    ]);
    expect(boardAgentStatus(state, "/code/x/.claude/worktrees/t")).toEqual({
      folderDir: "/code/x/.claude/worktrees/t",
      session: s,
      sessionCount: 1,
    });
  });

  it("is null without a worktree, without a matching folder, or without sessions", () => {
    const state = repos([{ dir: "/code/x", sessions: [] }]);
    expect(boardAgentStatus(state, undefined)).toBeNull();
    expect(boardAgentStatus(state, "")).toBeNull();
    expect(boardAgentStatus(state, "/code/elsewhere")).toBeNull();
    expect(boardAgentStatus(state, "/code/x")).toBeNull();
  });

  it("counts every session in the folder, not only the one it picks", () => {
    const state = repos([{ dir: "/w", sessions: [session("a"), session("b"), session("c")] }]);
    expect(boardAgentStatus(state, "/w")?.sessionCount).toBe(3);
  });
});

describe("mostUrgentSession", () => {
  it("a session that needs you beats one that is merely working", () => {
    const busy = session("busy", { agentState: agent("busy"), working: true });
    const waiting = session("waiting", {
      agentState: agent("waiting"),
      needsReason: "waitingForInput",
      needsSinceMs: 10,
    });
    expect(mostUrgentSession([busy, waiting])?.id).toBe("waiting");
  });

  it("the longest wait speaks for the folder when several need you", () => {
    const recent = session("recent", { needsReason: "finished", needsSinceMs: 500 });
    const old = session("old", { needsReason: "waitingForInput", needsSinceMs: 20 });
    expect(mostUrgentSession([recent, old])?.id).toBe("old");
  });

  it("an unseen terminal state counts as needing you", () => {
    const busy = session("busy", { agentState: agent("busy"), working: true });
    const done = session("done", { agentState: agent("complete"), unseen: true });
    expect(mostUrgentSession([busy, done])?.id).toBe("done");
  });

  it("otherwise follows the rail's alert order: error over waiting over busy", () => {
    const busy = session("busy", { agentState: agent("busy"), working: true });
    const err = session("err", { agentState: agent("error") });
    const waiting = session("waiting", { agentState: agent("waiting") });
    expect(mostUrgentSession([busy, waiting, err])?.id).toBe("err");
    expect(mostUrgentSession([busy, waiting])?.id).toBe("waiting");
  });

  it("a working agent outranks an idle one, which outranks a plain shell", () => {
    const shell = session("shell");
    const idle = session("idle", { agentState: agent("idle") });
    const busy = session("busy", { agentState: agent("busy"), working: true });
    expect(mostUrgentSession([shell, idle, busy])?.id).toBe("busy");
    expect(mostUrgentSession([shell, idle])?.id).toBe("idle");
  });

  it("a session still working at the prompt beats a newer idle one, whatever its status word", () => {
    const agentsOut = session("agents-out", {
      agentState: agent("idle"),
      working: true,
      createdAt: 1,
    });
    const idle = session("idle", { agentState: agent("idle"), createdAt: 2 });
    expect(mostUrgentSession([idle, agentsOut])?.id).toBe("agents-out");
  });

  it("an alert status outranks a plain idle agent", () => {
    const idle = session("idle", { agentState: agent("idle") });
    const waiting = session("waiting", { agentState: agent("waiting") });
    expect(mostUrgentSession([idle, waiting])?.id).toBe("waiting");
  });

  it("a live shell outranks a dead one; among equals the newest wins", () => {
    const dead = session("dead", { live: false, createdAt: 9 });
    const live = session("live", { createdAt: 1 });
    expect(mostUrgentSession([dead, live])?.id).toBe("live");
    const older = session("older", { createdAt: 1 });
    const newer = session("newer", { createdAt: 2 });
    expect(mostUrgentSession([older, newer])?.id).toBe("newer");
  });

  it("is undefined for no sessions and leaves the input untouched", () => {
    expect(mostUrgentSession([])).toBeUndefined();
    const list = [session("a", { createdAt: 1 }), session("b", { createdAt: 2 })];
    mostUrgentSession(list);
    expect(list.map((s) => s.id)).toEqual(["a", "b"]);
  });
});
