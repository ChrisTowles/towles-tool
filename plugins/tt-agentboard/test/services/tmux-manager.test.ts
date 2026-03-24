import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

// eslint-disable-next-line import/first -- vi.mock must come before imports (vitest hoisting)
import { execSync } from "node:child_process";
// eslint-disable-next-line import/first
import { TmuxManager } from "../../server/services/tmux-manager";

const mockExecSync = vi.mocked(execSync);

describe("TmuxManager", () => {
  let manager: TmuxManager;

  beforeEach(() => {
    manager = new TmuxManager();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("isAvailable()", () => {
    it("returns true when tmux is found", () => {
      mockExecSync.mockReturnValue(Buffer.from("/usr/bin/tmux"));
      expect(manager.isAvailable()).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith("which tmux", { stdio: "ignore" });
    });

    it("returns false when tmux is not found", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("not found");
      });
      expect(manager.isAvailable()).toBe(false);
    });
  });

  describe("createSession()", () => {
    it("calls correct tmux new-session command", () => {
      // sessionExists check fails (no existing session)
      mockExecSync.mockImplementation((cmd) => {
        if (typeof cmd === "string" && cmd.includes("has-session")) {
          throw new Error("no session");
        }
        return Buffer.from("");
      });

      const name = manager.createSession(7, "/home/user/repo");

      expect(name).toBe("card-7");
      expect(mockExecSync).toHaveBeenCalledWith(
        'tmux new-session -d -s card-7 -c "/home/user/repo"',
        { stdio: "ignore" },
      );
    });

    it("reuses existing session if already exists", () => {
      // sessionExists check succeeds
      mockExecSync.mockReturnValue(Buffer.from(""));

      const name = manager.createSession(7, "/home/user/repo");

      expect(name).toBe("card-7");
      // Should NOT have called new-session
      const newSessionCalls = mockExecSync.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("new-session"),
      );
      expect(newSessionCalls).toHaveLength(0);
    });
  });

  describe("sendCommand()", () => {
    it("sends command to tmux session", () => {
      mockExecSync.mockReturnValue(Buffer.from(""));

      manager.sendCommand("card-5", "claude -p 'do stuff'");

      expect(mockExecSync).toHaveBeenCalledWith(
        "tmux send-keys -t card-5 'claude -p '\\''do stuff'\\''' Enter",
      );
    });

    it("escapes single quotes in command", () => {
      mockExecSync.mockReturnValue(Buffer.from(""));

      manager.sendCommand("card-1", "echo 'hello' && echo 'world'");

      const call = mockExecSync.mock.calls[0]![0] as string;
      // Each ' in the original should become '\''
      expect(call).toContain("'\\''hello'\\''");
      expect(call).toContain("'\\''world'\\''");
    });
  });

  describe("killSession()", () => {
    it("kills session and removes from internal state", () => {
      // First create a session
      mockExecSync.mockImplementation((cmd) => {
        if (typeof cmd === "string" && cmd.includes("has-session")) {
          throw new Error("no session");
        }
        return Buffer.from("");
      });
      manager.createSession(3, "/tmp/repo");
      vi.clearAllMocks();

      mockExecSync.mockReturnValue(Buffer.from(""));
      manager.killSession("card-3");

      expect(mockExecSync).toHaveBeenCalledWith("tmux kill-session -t card-3", {
        stdio: "ignore",
      });
    });

    it("handles already-dead session gracefully", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("session not found");
      });

      // Should not throw
      expect(() => manager.killSession("card-99")).not.toThrow();
    });
  });

  describe("listSessions()", () => {
    it("filters for card-* prefix sessions", () => {
      mockExecSync.mockReturnValue("card-1\ncard-5\nmy-other-session\ncard-12\nwork\n" as never);

      const sessions = manager.listSessions();

      expect(sessions).toEqual(["card-1", "card-5", "card-12"]);
    });

    it("returns empty array when tmux has no sessions", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("no server running");
      });

      expect(manager.listSessions()).toEqual([]);
    });
  });

  describe("sessionExists()", () => {
    it("returns true when session exists", () => {
      mockExecSync.mockReturnValue(Buffer.from(""));

      expect(manager.sessionExists("card-1")).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith("tmux has-session -t card-1", {
        stdio: "ignore",
      });
    });

    it("returns false when session does not exist", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("no session");
      });

      expect(manager.sessionExists("card-99")).toBe(false);
    });
  });

  describe("startCapture()", () => {
    function createSessionForCapture(cardId: number) {
      mockExecSync.mockImplementation((cmd) => {
        if (typeof cmd === "string" && cmd.includes("has-session")) {
          throw new Error("no session");
        }
        return Buffer.from("");
      });
      manager.createSession(cardId, "/tmp/repo");
      vi.clearAllMocks();
    }

    it("sets up polling interval and calls callback with output", () => {
      createSessionForCapture(10);
      mockExecSync.mockReturnValue("some terminal output" as never);

      const callback = vi.fn();
      manager.startCapture("card-10", callback);

      // Advance past one interval (500ms)
      vi.advanceTimersByTime(500);

      expect(mockExecSync).toHaveBeenCalledWith(
        "tmux capture-pane -t card-10 -p -S -50",
        { encoding: "utf-8", timeout: 2000 },
      );
      expect(callback).toHaveBeenCalledWith("some terminal output");

      // Clean up
      manager.stopCapture("card-10");
    });

    it("clears previous interval if called twice", () => {
      createSessionForCapture(11);
      mockExecSync.mockReturnValue("output" as never);

      const callback1 = vi.fn();
      const callback2 = vi.fn();

      manager.startCapture("card-11", callback1);
      manager.startCapture("card-11", callback2);

      vi.advanceTimersByTime(500);

      // Only callback2 should be called (callback1's interval was cleared)
      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledWith("output");

      manager.stopCapture("card-11");
    });

    it("stops on execSync error (session ended)", () => {
      createSessionForCapture(12);
      mockExecSync.mockImplementation(() => {
        throw new Error("session not found");
      });

      const callback = vi.fn();
      manager.startCapture("card-12", callback);

      // First tick triggers the error
      vi.advanceTimersByTime(500);

      expect(callback).not.toHaveBeenCalled();

      // Further ticks should not call execSync again (interval was cleared)
      mockExecSync.mockClear();
      vi.advanceTimersByTime(1000);
      expect(mockExecSync).not.toHaveBeenCalled();
    });
  });

  describe("stopCapture()", () => {
    it("clears interval and resets state", () => {
      // Create session and start capture
      mockExecSync.mockImplementation((cmd) => {
        if (typeof cmd === "string" && cmd.includes("has-session")) {
          throw new Error("no session");
        }
        return Buffer.from("");
      });
      manager.createSession(20, "/tmp/repo");
      vi.clearAllMocks();

      mockExecSync.mockReturnValue("output" as never);
      const callback = vi.fn();
      manager.startCapture("card-20", callback);

      manager.stopCapture("card-20");

      // After stop, advancing timers should not trigger callback
      vi.advanceTimersByTime(1000);
      expect(callback).not.toHaveBeenCalled();
    });

    it("on non-captured session is a no-op", () => {
      // Create session but don't start capture
      mockExecSync.mockImplementation((cmd) => {
        if (typeof cmd === "string" && cmd.includes("has-session")) {
          throw new Error("no session");
        }
        return Buffer.from("");
      });
      manager.createSession(21, "/tmp/repo");

      // Should not throw
      expect(() => manager.stopCapture("card-21")).not.toThrow();

      // Also no-op for completely unknown sessions
      expect(() => manager.stopCapture("card-999")).not.toThrow();
    });
  });
});
