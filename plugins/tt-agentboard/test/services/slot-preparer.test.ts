import { describe, it, expect, vi, beforeEach } from "vitest";
import { SlotPreparer } from "../../server/domains/execution/slot-preparer";
import { createMockLogger } from "../helpers/mock-deps";

function createMockDeps() {
  return {
    logger: createMockLogger() as never,
    exec: vi.fn().mockResolvedValue({ stdout: "", exitCode: 0 }),
    existsSync: vi.fn().mockReturnValue(false),
  };
}

describe("SlotPreparer", () => {
  let preparer: SlotPreparer;
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
    preparer = new SlotPreparer(deps);
    vi.clearAllMocks();
  });

  describe("reset()", () => {
    it("syncs to main and installs deps", async () => {
      deps.existsSync.mockReturnValue(false);
      // pnpm-lock.yaml exists
      deps.existsSync.mockImplementation((path: string) => path.endsWith("pnpm-lock.yaml"));

      const result = await preparer.reset("/workspace/slot-1");

      // Should clean, checkout main, pull
      expect(deps.exec).toHaveBeenCalledWith(
        "git checkout -- . && git clean -fd",
        expect.objectContaining({ cwd: "/workspace/slot-1" }),
      );
      expect(deps.exec).toHaveBeenCalledWith(
        "git checkout main && git pull --ff-only",
        expect.objectContaining({ cwd: "/workspace/slot-1" }),
      );
      // Should install deps
      expect(deps.exec).toHaveBeenCalledWith(
        "pnpm install --frozen-lockfile",
        expect.objectContaining({ cwd: "/workspace/slot-1" }),
      );
      expect(result.depsInstalled).toBe(true);
      expect(result.packageManager).toBe("pnpm");
      expect(result.events).toContainEqual({
        type: "main_synced",
        detail: "Checked out and pulled main",
      });
      expect(result.events).toContainEqual(expect.objectContaining({ type: "deps_installed" }));
    });

    it("handles git sync failure gracefully", async () => {
      deps.exec.mockImplementation(async (cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("git checkout main")) {
          throw new Error("not a git repo");
        }
        return { stdout: "", exitCode: 0 };
      });

      const result = await preparer.reset("/workspace/slot-1");

      expect(result.events).toContainEqual({
        type: "warn",
        detail: "Could not checkout/pull main",
      });
    });

    it("skips install when no lockfile found", async () => {
      deps.existsSync.mockReturnValue(false);

      const result = await preparer.reset("/workspace/slot-1");

      expect(result.depsInstalled).toBe(false);
      expect(result.packageManager).toBeNull();
    });

    it("detects uv.lock for Python projects", async () => {
      deps.existsSync.mockImplementation((path: string) => path.endsWith("uv.lock"));

      const result = await preparer.reset("/workspace/slot-1");

      expect(deps.exec).toHaveBeenCalledWith(
        "uv sync --frozen",
        expect.objectContaining({ cwd: "/workspace/slot-1" }),
      );
      expect(result.packageManager).toBe("uv");
    });

    it("detects bun.lock", async () => {
      deps.existsSync.mockImplementation((path: string) => path.endsWith("bun.lock"));

      const result = await preparer.reset("/workspace/slot-1");

      expect(deps.exec).toHaveBeenCalledWith(
        "bun install --frozen-lockfile",
        expect.objectContaining({ cwd: "/workspace/slot-1" }),
      );
      expect(result.packageManager).toBe("bun");
    });

    it("detects package-lock.json for npm", async () => {
      deps.existsSync.mockImplementation((path: string) => path.endsWith("package-lock.json"));

      const result = await preparer.reset("/workspace/slot-1");

      expect(deps.exec).toHaveBeenCalledWith(
        "npm ci",
        expect.objectContaining({ cwd: "/workspace/slot-1" }),
      );
      expect(result.packageManager).toBe("npm");
    });

    it("detects requirements.txt for pip", async () => {
      deps.existsSync.mockImplementation((path: string) => path.endsWith("requirements.txt"));

      const result = await preparer.reset("/workspace/slot-1");

      expect(deps.exec).toHaveBeenCalledWith(
        "pip install -r requirements.txt",
        expect.objectContaining({ cwd: "/workspace/slot-1" }),
      );
      expect(result.packageManager).toBe("pip");
    });
  });

  describe("prepare()", () => {
    it("syncs main and creates branch for branchMode=create", async () => {
      const result = await preparer.prepare({
        slotPath: "/workspace/slot-1",
        branchMode: "create",
        branch: "agentboard/card-42",
      });

      // Should clean + checkout main + pull
      expect(deps.exec).toHaveBeenCalledWith(
        "git checkout -- . && git clean -fd",
        expect.objectContaining({ cwd: "/workspace/slot-1" }),
      );
      expect(deps.exec).toHaveBeenCalledWith(
        "git checkout main && git pull --ff-only",
        expect.objectContaining({ cwd: "/workspace/slot-1" }),
      );
      // Should create branch
      expect(deps.exec).toHaveBeenCalledWith(
        "git checkout -b agentboard/card-42",
        expect.objectContaining({ cwd: "/workspace/slot-1" }),
      );
      expect(result.branch).toBe("agentboard/card-42");
      expect(result.events).toContainEqual({
        type: "branch_created",
        detail: "agentboard/card-42",
      });
    });

    it("checks out existing branch for branchMode=current", async () => {
      const result = await preparer.prepare({
        slotPath: "/workspace/slot-1",
        branchMode: "current",
        branch: "feature/my-branch",
      });

      // Should NOT sync to main
      expect(deps.exec).not.toHaveBeenCalledWith(
        "git checkout main && git pull --ff-only",
        expect.anything(),
      );
      // Should fetch and checkout the branch
      expect(deps.exec).toHaveBeenCalledWith(
        "git fetch origin feature/my-branch",
        expect.objectContaining({ cwd: "/workspace/slot-1" }),
      );
      expect(deps.exec).toHaveBeenCalledWith(
        "git checkout feature/my-branch",
        expect.objectContaining({ cwd: "/workspace/slot-1" }),
      );
      expect(result.branch).toBe("feature/my-branch");
    });

    it("uses existingBranch when provided (resume case)", async () => {
      const result = await preparer.prepare({
        slotPath: "/workspace/slot-1",
        branchMode: "create",
        branch: "agentboard/card-42",
        existingBranch: "agentboard/card-42-prev",
      });

      // Should checkout the existing branch, NOT sync to main
      expect(deps.exec).toHaveBeenCalledWith(
        "git checkout agentboard/card-42-prev",
        expect.objectContaining({ cwd: "/workspace/slot-1" }),
      );
      expect(deps.exec).not.toHaveBeenCalledWith(
        "git checkout main && git pull --ff-only",
        expect.anything(),
      );
      expect(result.branch).toBe("agentboard/card-42-prev");
    });

    it("falls back to existing branch when create fails", async () => {
      deps.exec.mockImplementation(async (cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("checkout -b")) {
          throw new Error("branch already exists");
        }
        return { stdout: "", exitCode: 0 };
      });

      const result = await preparer.prepare({
        slotPath: "/workspace/slot-1",
        branchMode: "create",
        branch: "agentboard/card-42",
      });

      // Should try checkout -b, fail, then checkout existing
      expect(deps.exec).toHaveBeenCalledWith(
        "git checkout agentboard/card-42",
        expect.objectContaining({ cwd: "/workspace/slot-1" }),
      );
      expect(result.branch).toBe("agentboard/card-42");
      expect(result.events).toContainEqual({
        type: "branch_reused",
        detail: "agentboard/card-42",
      });
    });

    it("installs deps after branch setup", async () => {
      deps.existsSync.mockImplementation((path: string) => path.endsWith("pnpm-lock.yaml"));

      const result = await preparer.prepare({
        slotPath: "/workspace/slot-1",
        branchMode: "create",
        branch: "agentboard/card-42",
      });

      expect(result.depsInstalled).toBe(true);
      expect(result.packageManager).toBe("pnpm");
    });

    it("continues when install fails", async () => {
      deps.existsSync.mockImplementation((path: string) => path.endsWith("pnpm-lock.yaml"));
      deps.exec.mockImplementation(async (cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("pnpm install")) {
          throw new Error("install failed");
        }
        return { stdout: "", exitCode: 0 };
      });

      const result = await preparer.prepare({
        slotPath: "/workspace/slot-1",
        branchMode: "create",
        branch: "agentboard/card-42",
      });

      expect(result.depsInstalled).toBe(false);
      expect(result.packageManager).toBe("pnpm");
      expect(result.events).toContainEqual(
        expect.objectContaining({
          type: "warn",
          detail: expect.stringContaining("install failed"),
        }),
      );
    });
  });
});
