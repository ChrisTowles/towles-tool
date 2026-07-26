import { describe, expect, it } from "vitest";
import { emptyView, type AgentView } from "@/lib/agent";
import { chatStatus, chatTally, type ChatSession } from "@/lib/agent-sessions";

const session = (view: Partial<AgentView>, started = true): ChatSession => ({
  view: { ...emptyView(), ...view },
  started,
});

describe("chatStatus", () => {
  it("is off for a pane with nothing started", () => {
    expect(chatStatus(session({}, false))).toBe("off");
  });

  it("is idle once a session exists but no turn is in flight", () => {
    expect(chatStatus(session({}))).toBe("idle");
  });

  it("is idle for a spawned session whose start has not been acked yet", () => {
    // The echoed first turn lands before `agent_start` resolves, so `started`
    // is still false while a real session is coming up.
    expect(
      chatStatus(session({ turns: [{ id: "user-0", type: "user", text: "hi" }] }, false)),
    ).toBe("idle");
  });

  it("is working while a turn is running", () => {
    expect(chatStatus(session({ running: true }))).toBe("working");
  });

  it("reports the exit even if the turn never completed", () => {
    expect(chatStatus(session({ running: true, exitCode: 0 }))).toBe("exited");
    expect(chatStatus(session({ running: true, exitCode: 1 }))).toBe("error");
  });

  it("treats a signal death (null code) as an exit, not an error", () => {
    expect(chatStatus(session({ exitCode: null }))).toBe("exited");
  });
});

describe("chatTally", () => {
  it("ignores panes with no session behind them", () => {
    expect(chatTally([session({}, false)])).toEqual({ total: 0, busy: 0, error: 0 });
  });

  it("counts live chats as agents, by status", () => {
    expect(
      chatTally([
        session({ running: true }),
        session({ running: true }),
        session({}),
        session({ exitCode: 2 }),
        session({}, false),
      ]),
    ).toEqual({ total: 4, busy: 2, error: 1 });
  });
});
