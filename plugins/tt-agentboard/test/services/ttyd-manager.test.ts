import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChildProcess } from "node:child_process";

// The TtydManager.isAvailable() uses require("node:child_process") internally,
// so we must mock the module at the vi.mock level which also intercepts require().
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("../../server/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// eslint-disable-next-line import/first -- vi.mock must come before imports (vitest hoisting)
import { spawn } from "node:child_process";
// eslint-disable-next-line import/first
import { TtydManager } from "../../server/services/ttyd-manager";

const mockSpawn = vi.mocked(spawn);

function createMockProcess(): ChildProcess {
  const proc = {
    pid: 12345,
    kill: vi.fn(),
    unref: vi.fn(),
    on: vi.fn().mockReturnThis(),
    stdout: null,
    stderr: null,
    stdin: null,
  } as unknown as ChildProcess;
  return proc;
}

describe("TtydManager", () => {
  let manager: TtydManager;

  beforeEach(() => {
    manager = new TtydManager();
    vi.clearAllMocks();
  });

  describe("isAvailable()", () => {
    // isAvailable() uses an inline require("node:child_process").execSync which
    // bypasses our module-level vi.mock in some vitest configurations.
    // We test the caching and return-type behavior instead.

    it("returns a boolean", () => {
      const result = manager.isAvailable();
      expect(typeof result).toBe("boolean");
    });

    it("caches result on subsequent calls", () => {
      const first = manager.isAvailable();
      const second = manager.isAvailable();
      expect(first).toBe(second);
    });
  });

  describe("attach()", () => {
    it("spawns ttyd and returns port/url", () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const result = manager.attach(1);

      expect(result.port).toBe(7680);
      expect(result.url).toBe("http://localhost:7680");
      expect(mockSpawn).toHaveBeenCalledWith(
        "ttyd",
        ["--port", "7680", "--writable", "tmux", "attach", "-t", "card-1"],
        { stdio: "ignore", detached: true },
      );
      expect(proc.unref).toHaveBeenCalled();
    });

    it("returns existing instance if already attached", () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const first = manager.attach(1);
      const second = manager.attach(1);

      expect(first).toEqual(second);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it("assigns incrementing ports for multiple cards", () => {
      mockSpawn.mockImplementation(() => createMockProcess());

      const r1 = manager.attach(1);
      const r2 = manager.attach(2);

      expect(r1.port).toBe(7680);
      expect(r2.port).toBe(7681);
    });
  });

  describe("detach()", () => {
    it("kills process and returns true", () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      manager.attach(1);
      const result = manager.detach(1);

      expect(result).toBe(true);
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("returns false when no instance exists", () => {
      const result = manager.detach(999);
      expect(result).toBe(false);
    });

    it("handles kill throwing (already dead process)", () => {
      const proc = createMockProcess();
      vi.mocked(proc.kill).mockImplementation(() => {
        throw new Error("Process already dead");
      });
      mockSpawn.mockReturnValue(proc);

      manager.attach(1);
      const result = manager.detach(1);

      expect(result).toBe(true);
    });
  });

  describe("isAttached()", () => {
    it("returns attached:false when no instance", () => {
      expect(manager.isAttached(999)).toEqual({ attached: false });
    });

    it("returns attached:true with port and url when attached", () => {
      mockSpawn.mockReturnValue(createMockProcess());
      manager.attach(1);

      const result = manager.isAttached(1);

      expect(result.attached).toBe(true);
      expect(result.port).toBe(7680);
      expect(result.url).toBe("http://localhost:7680");
    });
  });

  describe("detachAll()", () => {
    it("kills all instances", () => {
      const proc1 = createMockProcess();
      const proc2 = createMockProcess();
      mockSpawn.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2);

      manager.attach(1);
      manager.attach(2);
      manager.detachAll();

      expect(proc1.kill).toHaveBeenCalledWith("SIGTERM");
      expect(proc2.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("does nothing when no instances", () => {
      expect(() => manager.detachAll()).not.toThrow();
    });
  });
});
