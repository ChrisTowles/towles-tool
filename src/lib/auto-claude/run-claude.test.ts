import consola from "consola";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { initConfig } from "./config";
import { createSpawnClaudeMock, createTestRepo } from "./test-helpers";
import type { MockClaudeImpl, TestRepo } from "./test-helpers";

consola.level = -999;

let mockSpawnImpl: MockClaudeImpl = null;
vi.mock("./spawn-claude", () => createSpawnClaudeMock(() => mockSpawnImpl));

describe("runClaude (mocked spawn-claude)", () => {
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
    mockSpawnImpl = null;
    vi.clearAllMocks();
  });

  it("parses stream-json result event", async () => {
    mockSpawnImpl = () => ({
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

    const { spawnClaude } = await import("./spawn-claude");
    expect(spawnClaude).toHaveBeenCalledWith(
      expect.arrayContaining([
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "plan",
        "--max-turns",
        "10",
        "@test-prompt.md",
      ]),
    );
  });

  it("returns fallback when no result event in stream", async () => {
    mockSpawnImpl = () => ({
      stdout: '{"type":"system","message":"starting"}',
      exitCode: 0,
    });

    await initConfig({ repo: "test/repo", mainBranch: "main" });

    const { runClaude } = await import("./utils");

    const result = await runClaude({
      promptFile: "test.md",
      permissionMode: "acceptEdits",
    });

    expect(result.result).toBe("");
    expect(result.is_error).toBe(false);
    expect(result.total_cost_usd).toBe(0);
  });

  it("retries on failure when retry is enabled", async () => {
    let callCount = 0;
    mockSpawnImpl = () => {
      callCount++;
      if (callCount < 3) {
        return { stdout: "", exitCode: 1 };
      }
      return {
        stdout: JSON.stringify({
          result: "ok",
          is_error: false,
          total_cost_usd: 0,
          num_turns: 1,
        }),
        exitCode: 0,
      };
    };

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
    mockSpawnImpl = () => ({ stdout: "", exitCode: 1 });

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
