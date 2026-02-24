import consola from "consola";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { initConfig } from "./config";
import { createTestRepo } from "./test-helpers";
import type { TestRepo } from "./test-helpers";

consola.level = -999;

// ── File-level tinyexec mock -- intercepts all x() calls ──

let mockXImpl: ((...args: unknown[]) => unknown) | null = null;

vi.mock("tinyexec", () => ({
  x: vi.fn((...args: unknown[]) => {
    if (mockXImpl) return mockXImpl(...args);
    throw new Error("mockXImpl not set");
  }),
}));

describe("runClaude (mocked tinyexec)", () => {
  let originalCwd: string;
  let repo: TestRepo;

  beforeAll(async () => {
    originalCwd = process.cwd();
    repo = createTestRepo();
    process.chdir(repo.dir);
  });

  afterAll(() => {
    process.chdir(originalCwd);
    repo.cleanup();
  });

  beforeEach(() => {
    mockXImpl = null;
    vi.clearAllMocks();
  });

  it("constructs correct args and parses JSON result", async () => {
    mockXImpl = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        result: "All done",
        is_error: false,
        total_cost_usd: 0.05,
        num_turns: 3,
      }),
      exitCode: 0,
    });

    await initConfig({ repo: "test/repo", mainBranch: "main" });

    const { runClaude } = await import("./utils");

    const result = await runClaude({
      promptFile: "test-prompt.md",
      permissionMode: "plan",
      maxTurns: 10,
    });

    expect(result.result).toBe("All done");
    expect(result.is_error).toBe(false);
    expect(result.num_turns).toBe(3);

    expect(mockXImpl).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining([
        "-p",
        "--output-format",
        "json",
        "--permission-mode",
        "plan",
        "--max-turns",
        "10",
        "@test-prompt.md",
      ]),
      expect.any(Object),
    );
  });

  it("returns fallback when JSON parsing fails", async () => {
    mockXImpl = vi.fn().mockResolvedValue({ stdout: "not json output", exitCode: 0 });

    await initConfig({ repo: "test/repo", mainBranch: "main" });

    const { runClaude } = await import("./utils");

    const result = await runClaude({
      promptFile: "test.md",
      permissionMode: "acceptEdits",
    });

    expect(result.result).toBe("not json output");
    expect(result.is_error).toBe(false);
    expect(result.total_cost_usd).toBe(0);
  });

  it("retries on failure when retry is enabled", async () => {
    let callCount = 0;
    mockXImpl = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount < 3) {
        throw new Error("Claude process failed");
      }
      return Promise.resolve({
        stdout: JSON.stringify({
          result: "ok",
          is_error: false,
          total_cost_usd: 0,
          num_turns: 1,
        }),
        exitCode: 0,
      });
    });

    await initConfig({
      repo: "test/repo",
      mainBranch: "main",
      loopRetryEnabled: true,
      maxRetries: 5,
      retryDelayMs: 1,
      maxRetryDelayMs: 5,
    });

    const { runClaude } = await import("./utils");

    const result = await runClaude({
      promptFile: "test.md",
      permissionMode: "plan",
      retry: true,
    });

    expect(result.result).toBe("ok");
    expect(callCount).toBe(3);
  }, 10_000);

  it("throws after max retries exhausted", async () => {
    mockXImpl = vi.fn().mockRejectedValue(new Error("Claude crash"));

    await initConfig({
      repo: "test/repo",
      mainBranch: "main",
      loopRetryEnabled: true,
      maxRetries: 2,
      retryDelayMs: 1,
      maxRetryDelayMs: 5,
    });

    const { runClaude } = await import("./utils");

    await expect(
      runClaude({
        promptFile: "test.md",
        permissionMode: "plan",
        retry: true,
      }),
    ).rejects.toThrow("Claude failed after 2 retries");
  }, 10_000);
});
