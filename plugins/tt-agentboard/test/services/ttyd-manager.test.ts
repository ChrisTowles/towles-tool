import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockLogger } from "../helpers/mock-deps";
import { TtydManager } from "../../server/domains/infra/ttyd-manager";

function createMockPty() {
  return {
    pid: 12345,
    cols: 80,
    rows: 24,
    kill: vi.fn(),
    close: vi.fn(),
    onData: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onExit: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    exited: Promise.resolve(0),
    exitCode: null,
    process: "ttyd",
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    clear: vi.fn(),
    waitFor: vi.fn(),
    handleFlowControl: false,
  };
}

describe("TtydManager", () => {
  let manager: TtydManager;
  let mockSpawn: ReturnType<typeof vi.fn>;
  let mockExec: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSpawn = vi.fn();
    mockExec = vi.fn().mockResolvedValue({ stdout: "", exitCode: 0 });
    manager = new TtydManager({
      spawn: mockSpawn as never,
      exec: mockExec as never,
      logger: createMockLogger() as never,
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    manager.detachAll();
  });

  describe("isAvailable()", () => {
    it("returns true when spawn succeeds", () => {
      const pty = createMockPty();
      mockSpawn.mockReturnValue(pty);
      const result = manager.isAvailable();
      expect(result).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith("which", ["ttyd"], expect.any(Object));
    });

    it("returns false when spawn throws", () => {
      mockSpawn.mockImplementation(() => {
        throw new Error("not found");
      });
      const result = manager.isAvailable();
      expect(result).toBe(false);
    });

    it("caches result on subsequent calls", () => {
      const pty = createMockPty();
      mockSpawn.mockReturnValue(pty);
      const first = manager.isAvailable();
      const second = manager.isAvailable();
      expect(first).toBe(second);
      // Only called once due to caching
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });
  });

  describe("attach()", () => {
    it("spawns ttyd and returns port/url", () => {
      const proc = createMockPty();
      mockSpawn.mockReturnValue(proc);

      const result = manager.attach(1);

      expect(result.port).toBe(7700);
      expect(result.url).toBe("http://localhost:7700");
      expect(mockSpawn).toHaveBeenCalledWith(
        "ttyd",
        ["--port", "7700", "--writable", "tmux", "attach", "-t", "card-1"],
        expect.any(Object),
      );
    });

    it("returns existing instance if already attached", () => {
      const proc = createMockPty();
      mockSpawn.mockReturnValue(proc);

      const first = manager.attach(1);
      const second = manager.attach(1);

      expect(first).toEqual(second);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it("assigns incrementing ports for multiple cards", () => {
      mockSpawn.mockImplementation(() => createMockPty());

      const r1 = manager.attach(1);
      const r2 = manager.attach(2);

      expect(r1.port).toBe(7700);
      expect(r2.port).toBe(7701);
    });
  });

  describe("detach()", () => {
    it("kills process and returns true", () => {
      const proc = createMockPty();
      mockSpawn.mockReturnValue(proc);

      manager.attach(1);
      const result = manager.detach(1);

      expect(result).toBe(true);
      expect(proc.kill).toHaveBeenCalled();
    });

    it("returns false when no instance exists", () => {
      const result = manager.detach(999);
      expect(result).toBe(false);
    });

    it("handles kill throwing (already dead process)", () => {
      const proc = createMockPty();
      proc.kill.mockImplementation(() => {
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
      mockSpawn.mockReturnValue(createMockPty());
      manager.attach(1);

      const result = manager.isAttached(1);

      expect(result.attached).toBe(true);
      expect(result.port).toBe(7700);
      expect(result.url).toBe("http://localhost:7700");
    });
  });

  describe("detachAll()", () => {
    it("kills all instances", () => {
      const proc1 = createMockPty();
      const proc2 = createMockPty();
      mockSpawn.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2);

      manager.attach(1);
      manager.attach(2);
      manager.detachAll();

      expect(proc1.kill).toHaveBeenCalled();
      expect(proc2.kill).toHaveBeenCalled();
    });

    it("does nothing when no instances", () => {
      expect(() => manager.detachAll()).not.toThrow();
    });
  });
});
