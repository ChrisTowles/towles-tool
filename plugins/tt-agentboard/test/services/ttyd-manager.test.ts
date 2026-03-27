import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import { createMockLogger } from "../helpers/mock-deps";
import { TtydManager } from "../../server/domains/infra/ttyd-manager";

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
  let mockSpawn: ReturnType<typeof vi.fn>;
  let mockExecSync: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSpawn = vi.fn();
    mockExecSync = vi.fn();
    manager = new TtydManager({
      spawn: mockSpawn as never,
      execSync: mockExecSync as never,
      logger: createMockLogger() as never,
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    manager.detachAll();
  });

  describe("isAvailable()", () => {
    it("returns true when execSync succeeds", () => {
      mockExecSync.mockReturnValue(undefined);
      const result = manager.isAvailable();
      expect(result).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith("which ttyd", { stdio: "ignore" });
    });

    it("returns false when execSync throws", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("not found");
      });
      const result = manager.isAvailable();
      expect(result).toBe(false);
    });

    it("caches result on subsequent calls", () => {
      mockExecSync.mockReturnValue(undefined);
      const first = manager.isAvailable();
      const second = manager.isAvailable();
      expect(first).toBe(second);
      // Only called once due to caching
      expect(mockExecSync).toHaveBeenCalledTimes(1);
    });
  });

  describe("attach()", () => {
    it("spawns ttyd and returns port/url", () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const result = manager.attach(1);

      expect(result.port).toBe(7700);
      expect(result.url).toBe("http://localhost:7700");
      expect(mockSpawn).toHaveBeenCalledWith(
        "ttyd",
        ["--port", "7700", "--writable", "tmux", "attach", "-t", "card-1"],
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

      expect(r1.port).toBe(7700);
      expect(r2.port).toBe(7701);
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
      expect(result.port).toBe(7700);
      expect(result.url).toBe("http://localhost:7700");
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
