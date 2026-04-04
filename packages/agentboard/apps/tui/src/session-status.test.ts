import { describe, it, expect } from "vitest";
import type { SessionData, AgentEvent } from "@tt-agentboard/runtime";
import { computeSessionStatusCounts } from "./session-status";

function makeSession(agentStatus?: AgentEvent["status"]): SessionData {
  return {
    name: "test",
    createdAt: Date.now(),
    dir: "/tmp",
    branch: "main",
    dirty: false,
    isWorktree: false,
    filesChanged: 0,
    linesAdded: 0,
    linesRemoved: 0,
    commitsDelta: 0,
    unseen: false,
    panes: 1,
    ports: [],
    windows: 1,
    uptime: "0s",
    agentState: agentStatus
      ? { agent: "claude", session: "test", status: agentStatus, ts: Date.now() }
      : null,
    agents: [],
    eventTimestamps: [],
  };
}

describe("computeSessionStatusCounts", () => {
  it("returns all zeros for empty sessions", () => {
    expect(computeSessionStatusCounts([])).toEqual({ active: 0, error: 0, idle: 0 });
  });

  it("counts running sessions as active", () => {
    const sessions = [makeSession("running"), makeSession("running")];
    expect(computeSessionStatusCounts(sessions)).toEqual({ active: 2, error: 0, idle: 0 });
  });

  it("counts waiting sessions as active", () => {
    const sessions = [makeSession("waiting")];
    expect(computeSessionStatusCounts(sessions)).toEqual({ active: 1, error: 0, idle: 0 });
  });

  it("counts error sessions", () => {
    const sessions = [makeSession("error")];
    expect(computeSessionStatusCounts(sessions)).toEqual({ active: 0, error: 1, idle: 0 });
  });

  it("counts idle, done, interrupted, and null agentState as idle", () => {
    const sessions = [
      makeSession("idle"),
      makeSession("done"),
      makeSession("interrupted"),
      makeSession(undefined),
    ];
    expect(computeSessionStatusCounts(sessions)).toEqual({ active: 0, error: 0, idle: 4 });
  });

  it("counts mixed statuses correctly", () => {
    const sessions = [
      makeSession("running"),
      makeSession("error"),
      makeSession("idle"),
      makeSession("waiting"),
      makeSession("done"),
    ];
    expect(computeSessionStatusCounts(sessions)).toEqual({ active: 2, error: 1, idle: 2 });
  });
});
