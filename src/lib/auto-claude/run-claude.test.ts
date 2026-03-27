import consola from "consola";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { initConfig } from "./config";
import { createMockClaudeProcess, createTestRepo } from "./test-helpers";
import type { TestRepo } from "./test-helpers";
import type { SpawnClaudeFn } from "./spawn-claude";

consola.level = -999;

describe("runClaude (injected spawnFn)", () => {
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
    vi.clearAllMocks();
  });

  it("parses stream-json result event", async () => {
    const mockSpawnClaude: SpawnClaudeFn = vi.fn((args: string[]) => {
      return createMockClaudeProcess(
        JSON.stringify({
          result: "All done",
          is_error: false,
          total_cost_usd: 0.05,
          num_turns: 3,
        }),
        0,
      );
    });

    await initConfig({ repo: "test/repo", mainBranch: "main" });

    const { runClaude } = await import("./claude-cli");

    const result = await runClaude({
      promptFile: "test-prompt.md",
      maxTurns: 10,
      spawnFn: mockSpawnClaude,
    });

    expect(result.result).toBe("All done");
    expect(result.is_error).toBe(false);
    expect(result.num_turns).toBe(3);

    expect(mockSpawnClaude).toHaveBeenCalledWith(
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

  it("logs tool names from stream_event and shows thinking indicator", async () => {
    const infoSpy = vi.spyOn(consola, "info");

    const thinkingEvent = {
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: { type: "thinking" },
      },
    };
    const toolEvent = {
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

    const mockSpawnClaude: SpawnClaudeFn = vi.fn(() => {
      return createMockClaudeProcess(
        [thinkingEvent, toolEvent, resultEvent].map((e) => JSON.stringify(e)).join("\n"),
        0,
      );
    });

    await initConfig({ repo: "test/repo", mainBranch: "main" });

    const { runClaude } = await import("./claude-cli");
    const result = await runClaude({ promptFile: "test.md", spawnFn: mockSpawnClaude });

    expect(result.result).toBe("Done");
    expect(result.num_turns).toBe(1);

    const infoCalls = infoSpy.mock.calls.map((c) => String(c[0]));
    expect(infoCalls.some((msg) => msg.includes("thinking"))).toBe(true);
    expect(infoCalls.some((msg) => msg.includes("Edit"))).toBe(true);

    infoSpy.mockRestore();
  });

  it("returns fallback when no result event in stream", async () => {
    const mockSpawnClaude: SpawnClaudeFn = vi.fn(() => {
      return createMockClaudeProcess('{"type":"system","message":"starting"}', 0);
    });

    await initConfig({ repo: "test/repo", mainBranch: "main" });

    const { runClaude } = await import("./claude-cli");

    const result = await runClaude({
      promptFile: "test.md",
      spawnFn: mockSpawnClaude,
    });

    expect(result.result).toBe("");
    expect(result.is_error).toBe(false);
    expect(result.total_cost_usd).toBe(0);
  });
});
