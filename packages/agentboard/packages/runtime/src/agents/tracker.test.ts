import { describe, it, expect, beforeEach } from "bun:test";
import { AgentTracker, instanceKey } from "./tracker";
import type { AgentEvent } from "../contracts/agent";

function makeEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    agent: "claude-code",
    session: "main",
    status: "running",
    ts: Date.now(),
    ...overrides,
  };
}

describe("instanceKey", () => {
  it("returns agent name when no threadId", () => {
    expect(instanceKey("claude-code")).toBe("claude-code");
  });

  it("returns agent:threadId when threadId provided", () => {
    expect(instanceKey("claude-code", "abc123")).toBe("claude-code:abc123");
  });
});

describe("AgentTracker", () => {
  let tracker: AgentTracker;

  beforeEach(() => {
    tracker = new AgentTracker();
  });

  describe("applyEvent / getState", () => {
    it("returns null for unknown session", () => {
      expect(tracker.getState("unknown")).toBeNull();
    });

    it("tracks a single agent event", () => {
      const event = makeEvent({ status: "running" });
      tracker.applyEvent(event);

      const state = tracker.getState("main");
      expect(state).not.toBeNull();
      expect(state!.status).toBe("running");
      expect(state!.agent).toBe("claude-code");
    });

    it("returns highest priority agent", () => {
      tracker.applyEvent(makeEvent({ agent: "amp", status: "idle" }));
      tracker.applyEvent(makeEvent({ agent: "claude-code", status: "running" }));

      const state = tracker.getState("main");
      expect(state!.status).toBe("running");
    });
  });

  describe("getAgents", () => {
    it("returns empty array for unknown session", () => {
      expect(tracker.getAgents("unknown")).toEqual([]);
    });

    it("returns all agents for a session sorted by ts desc", () => {
      tracker.applyEvent(makeEvent({ agent: "amp", ts: 100 }));
      tracker.applyEvent(makeEvent({ agent: "claude-code", ts: 200 }));

      const agents = tracker.getAgents("main");
      expect(agents).toHaveLength(2);
      expect(agents[0]!.agent).toBe("claude-code");
      expect(agents[1]!.agent).toBe("amp");
    });
  });

  describe("getEventTimestamps", () => {
    it("tracks event timestamps per session", () => {
      tracker.applyEvent(makeEvent({ ts: 100 }));
      tracker.applyEvent(makeEvent({ ts: 200 }));

      const timestamps = tracker.getEventTimestamps("main");
      expect(timestamps).toEqual([100, 200]);
    });

    it("caps at 30 timestamps", () => {
      for (let i = 0; i < 40; i++) {
        tracker.applyEvent(makeEvent({ ts: i }));
      }
      const timestamps = tracker.getEventTimestamps("main");
      expect(timestamps).toHaveLength(30);
      expect(timestamps[0]).toBe(10);
    });
  });

  describe("unseen tracking", () => {
    it("marks terminal status as unseen when session not active", () => {
      tracker.applyEvent(makeEvent({ status: "done" }));
      expect(tracker.isUnseen("main")).toBe(true);
    });

    it("marks seen on focus", () => {
      tracker.applyEvent(makeEvent({ status: "done" }));
      tracker.handleFocus("main");
      expect(tracker.isUnseen("main")).toBe(false);
    });

    it("markSeen clears unseen flags", () => {
      tracker.applyEvent(makeEvent({ status: "error" }));
      expect(tracker.markSeen("main")).toBe(true);
      expect(tracker.isUnseen("main")).toBe(false);
    });
  });

  describe("dismiss", () => {
    it("removes an agent instance", () => {
      tracker.applyEvent(makeEvent({ agent: "claude-code" }));
      const removed = tracker.dismiss("main", "claude-code");
      expect(removed).toBe(true);
      expect(tracker.getState("main")).toBeNull();
    });

    it("returns false for non-existent agent", () => {
      expect(tracker.dismiss("main", "nonexistent")).toBe(false);
    });
  });

  describe("pruneStuck", () => {
    it("prunes running agents older than timeout", () => {
      tracker.applyEvent(makeEvent({ status: "running", ts: Date.now() - 10_000 }));
      tracker.pruneStuck(5_000);
      expect(tracker.getState("main")).toBeNull();
    });

    it("does not prune pinned agents", () => {
      tracker.applyEvent(makeEvent({ status: "running", ts: Date.now() - 10_000 }));
      tracker.setPinnedInstances("main", ["claude-code"]);
      tracker.pruneStuck(5_000);
      expect(tracker.getState("main")).not.toBeNull();
    });
  });

  describe("pruneTerminal", () => {
    it("prunes seen terminal agents after timeout", () => {
      const event = makeEvent({ status: "done", ts: Date.now() - 6 * 60 * 1000 });
      tracker.applyEvent(event);
      tracker.markSeen("main");
      tracker.pruneTerminal();
      expect(tracker.getState("main")).toBeNull();
    });

    it("does not prune unseen terminal agents", () => {
      tracker.applyEvent(makeEvent({ status: "done", ts: Date.now() - 6 * 60 * 1000 }));
      // Don't mark seen
      tracker.pruneTerminal();
      expect(tracker.getState("main")).not.toBeNull();
    });
  });

  describe("pruneStale", () => {
    const TWELVE_HOURS = 12 * 60 * 60 * 1000;

    it("prunes waiting agents older than threshold", () => {
      tracker.applyEvent(makeEvent({ status: "waiting", ts: Date.now() - TWELVE_HOURS - 1000 }));
      tracker.pruneStale(TWELVE_HOURS);
      expect(tracker.getState("main")).toBeNull();
    });

    it("prunes running agents older than threshold", () => {
      tracker.applyEvent(makeEvent({ status: "running", ts: Date.now() - TWELVE_HOURS - 1000 }));
      tracker.pruneStale(TWELVE_HOURS);
      expect(tracker.getState("main")).toBeNull();
    });

    it("leaves fresh agents alone", () => {
      tracker.applyEvent(makeEvent({ status: "waiting", ts: Date.now() - 1000 }));
      tracker.pruneStale(TWELVE_HOURS);
      expect(tracker.getState("main")).not.toBeNull();
    });

    it("respects pinned instances", () => {
      tracker.applyEvent(makeEvent({ status: "waiting", ts: Date.now() - TWELVE_HOURS - 1000 }));
      tracker.setPinnedInstances("main", ["claude-code"]);
      tracker.pruneStale(TWELVE_HOURS);
      expect(tracker.getState("main")).not.toBeNull();
    });

    it("uses details.lastActivityAt when present", () => {
      tracker.applyEvent(
        makeEvent({
          status: "waiting",
          ts: Date.now() - TWELVE_HOURS - 1000,
          details: { lastActivityAt: Date.now() - 1000 },
        }),
      );
      tracker.pruneStale(TWELVE_HOURS);
      expect(tracker.getState("main")).not.toBeNull();
    });

    it("falls back to event.ts when lastActivityAt missing", () => {
      tracker.applyEvent(makeEvent({ status: "waiting", ts: Date.now() - TWELVE_HOURS - 1000 }));
      tracker.pruneStale(TWELVE_HOURS);
      expect(tracker.getState("main")).toBeNull();
    });
  });

  describe("pruneIdle", () => {
    const GRACE = 30_000;

    it("prunes idle agents older than threshold", () => {
      tracker.applyEvent(makeEvent({ status: "idle", ts: Date.now() - GRACE - 1000 }));
      tracker.pruneIdle(GRACE);
      expect(tracker.getState("main")).toBeNull();
    });

    it("leaves fresh idle agents alone", () => {
      tracker.applyEvent(makeEvent({ status: "idle", ts: Date.now() - 1000 }));
      tracker.pruneIdle(GRACE);
      expect(tracker.getState("main")).not.toBeNull();
    });

    it("does not prune non-idle agents", () => {
      tracker.applyEvent(makeEvent({ status: "done", ts: Date.now() - GRACE - 1000 }));
      tracker.pruneIdle(GRACE);
      expect(tracker.getState("main")).not.toBeNull();
    });

    it("respects pinned instances (live pane keeps the agent)", () => {
      tracker.applyEvent(
        makeEvent({ threadId: "t1", status: "idle", ts: Date.now() - GRACE - 1000 }),
      );
      tracker.setPinnedInstances("main", ["claude-code:t1"]);
      tracker.pruneIdle(GRACE);
      expect(tracker.getState("main")).not.toBeNull();
    });

    it("prunes the cleared session but keeps the live one", () => {
      // Simulates /clear: old session (t1) went idle, new session (t2) is live + pinned.
      tracker.applyEvent(
        makeEvent({ threadId: "t1", status: "idle", ts: Date.now() - GRACE - 1000 }),
      );
      tracker.applyEvent(makeEvent({ threadId: "t2", status: "running", ts: Date.now() }));
      tracker.setPinnedInstances("main", ["claude-code:t2"]);
      tracker.pruneIdle(GRACE);
      const agents = tracker.getAgents("main");
      expect(agents).toHaveLength(1);
      expect(agents[0]!.threadId).toBe("t2");
    });

    it("uses details.lastActivityAt when present", () => {
      tracker.applyEvent(
        makeEvent({
          status: "idle",
          ts: Date.now() - GRACE - 1000,
          details: { lastActivityAt: Date.now() - 1000 },
        }),
      );
      tracker.pruneIdle(GRACE);
      expect(tracker.getState("main")).not.toBeNull();
    });
  });

  describe("pruneSupersededByPane", () => {
    it("drops older instance when same agent reappears with new threadId in same pane", () => {
      tracker.applyEvent(makeEvent({ threadId: "t1", status: "waiting", paneId: "%5", ts: 1000 }));
      tracker.applyEvent(makeEvent({ threadId: "t2", status: "running", paneId: "%5", ts: 2000 }));
      tracker.setPinnedInstances("main", ["claude-code:t2"]);
      tracker.pruneSupersededByPane();
      const agents = tracker.getAgents("main");
      expect(agents).toHaveLength(1);
      expect(agents[0]!.threadId).toBe("t2");
    });

    it("keeps both when instances are in different panes", () => {
      tracker.applyEvent(makeEvent({ threadId: "t1", status: "waiting", paneId: "%5", ts: 1000 }));
      tracker.applyEvent(makeEvent({ threadId: "t2", status: "running", paneId: "%7", ts: 2000 }));
      tracker.pruneSupersededByPane();
      expect(tracker.getAgents("main")).toHaveLength(2);
    });

    it("keeps both when they're different agent types in the same pane", () => {
      tracker.applyEvent(makeEvent({ agent: "claude-code", paneId: "%5", ts: 1000 }));
      tracker.applyEvent(makeEvent({ agent: "amp", paneId: "%5", ts: 2000 }));
      tracker.pruneSupersededByPane();
      expect(tracker.getAgents("main")).toHaveLength(2);
    });

    it("ignores instances without a paneId", () => {
      tracker.applyEvent(makeEvent({ threadId: "t1", paneId: undefined, ts: 1000 }));
      tracker.applyEvent(makeEvent({ threadId: "t2", paneId: undefined, ts: 2000 }));
      tracker.pruneSupersededByPane();
      expect(tracker.getAgents("main")).toHaveLength(2);
    });

    it("uses details.lastActivityAt for recency comparison", () => {
      tracker.applyEvent(
        makeEvent({
          threadId: "t1",
          paneId: "%5",
          ts: 5000,
          details: { lastActivityAt: 9000 },
        }),
      );
      tracker.applyEvent(
        makeEvent({
          threadId: "t2",
          paneId: "%5",
          ts: 6000,
          details: { lastActivityAt: 7000 },
        }),
      );
      tracker.pruneSupersededByPane();
      const agents = tracker.getAgents("main");
      expect(agents).toHaveLength(1);
      expect(agents[0]!.threadId).toBe("t1");
    });
  });

  describe("multi-thread support", () => {
    it("tracks multiple threads for the same agent", () => {
      tracker.applyEvent(makeEvent({ threadId: "t1", status: "running" }));
      tracker.applyEvent(makeEvent({ threadId: "t2", status: "done" }));

      const agents = tracker.getAgents("main");
      expect(agents).toHaveLength(2);
    });

    it("getState returns highest priority across threads", () => {
      tracker.applyEvent(makeEvent({ threadId: "t1", status: "done" }));
      tracker.applyEvent(makeEvent({ threadId: "t2", status: "running" }));

      const state = tracker.getState("main");
      expect(state!.status).toBe("running");
    });
  });
});
