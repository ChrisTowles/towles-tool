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
