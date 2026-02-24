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
        "--include-partial-messages",
        "--dangerously-skip-permissions",
        "--max-turns",
        "10",
        "@test-prompt.md",
      ]),
    );
  });

  it("logs tool names from assistant turn events with object message format", async () => {
    const infoSpy = vi.spyOn(consola, "info");

    const assistantEvent = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me read the file." },
          { type: "tool_use", id: "t1", name: "Read", input: {} },
        ],
      },
    };
    const streamEvent = {
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use", name: "Edit" },
      },
    };
    const resultEvent = {
      result: "Done",
      is_error: false,
      total_cost_usd: 0.01,
      num_turns: 1,
    };

    mockSpawnImpl = () => ({
      stdout: [assistantEvent, streamEvent, resultEvent].map((e) => JSON.stringify(e)).join("\n"),
      exitCode: 0,
    });

    await initConfig({ repo: "test/repo", mainBranch: "main" });

    const { runClaude } = await import("./utils");
    const result = await runClaude({ promptFile: "test.md" });

    expect(result.result).toBe("Done");
    expect(result.num_turns).toBe(1);

    // Verify consola.info was called with tool names (Read from assistant turn, Edit from stream_event)
    const infoCalls = infoSpy.mock.calls.map((c) => String(c[0]));
    expect(infoCalls.some((msg) => msg.includes("Read"))).toBe(true);
    expect(infoCalls.some((msg) => msg.includes("Edit"))).toBe(true);

    infoSpy.mockRestore();
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
        retry: true,
      }),
    ).rejects.toThrow("Claude failed after 2 retries");
  }, 10_000);
});
