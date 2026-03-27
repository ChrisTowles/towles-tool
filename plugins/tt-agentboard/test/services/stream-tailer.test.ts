import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockLogger } from "../helpers/mock-deps";
import { StreamTailer } from "../../server/domains/infra/stream-tailer";

describe("StreamTailer", () => {
  let testDir: string;
  let logFile: string;
  let streamTailer: StreamTailer;
  const emittedEvents: Array<{ cardId: number; event: unknown; timestamp: number }> = [];
  let mockEventBus: {
    emit: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    emittedEvents.length = 0;

    testDir = join(tmpdir(), `stream-tailer-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    logFile = join(testDir, "test.ndjson");
    writeFileSync(logFile, "");

    mockEventBus = {
      emit: vi.fn((type: string, data: unknown) => {
        if (type === "agent:activity") {
          emittedEvents.push(data as { cardId: number; event: unknown; timestamp: number });
        }
      }),
      on: vi.fn(),
      off: vi.fn(),
    };

    streamTailer = new StreamTailer({
      eventBus: mockEventBus as never,
      logger: createMockLogger() as never,
    });
  });

  afterEach(() => {
    streamTailer.stopAll();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("parses existing lines from file on start", async () => {
    const toolLine = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Read", input: { file_path: "/tmp/test.ts" } }],
      },
    });
    writeFileSync(logFile, toolLine + "\n");

    await streamTailer.startTailing(1, logFile);

    // Give a small delay for async processing
    await new Promise((r) => setTimeout(r, 100));

    expect(emittedEvents.length).toBeGreaterThanOrEqual(1);
    const event = emittedEvents[0];
    expect(event.cardId).toBe(1);
    expect((event.event as { kind: string }).kind).toBe("tool_use");
    expect((event.event as { name: string }).name).toBe("Read");
  });

  it("picks up new lines appended after tailing starts", async () => {
    await streamTailer.startTailing(2, logFile);

    // Append a line after tailing started
    const resultLine = JSON.stringify({
      result: "Done",
      is_error: false,
      num_turns: 3,
      cost_usd: 0.01,
      duration_ms: 5000,
    });
    appendFileSync(logFile, resultLine + "\n");

    // Wait for fs.watch to trigger and process
    await new Promise((r) => setTimeout(r, 500));

    const resultEvents = emittedEvents.filter(
      (e) => (e.event as { kind: string }).kind === "result",
    );
    expect(resultEvents.length).toBeGreaterThanOrEqual(1);
    expect(resultEvents[0].cardId).toBe(2);
  });

  it("parses multiple event types in sequence", async () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "thinking", thinking: "Planning the approach" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Here is what I found" }],
        },
      }),
    ];
    writeFileSync(logFile, lines.join("\n") + "\n");

    await streamTailer.startTailing(3, logFile);
    await new Promise((r) => setTimeout(r, 100));

    const kinds = emittedEvents.map((e) => (e.event as { kind: string }).kind);
    expect(kinds).toContain("thinking");
    expect(kinds).toContain("tool_use");
    expect(kinds).toContain("text");
  });

  it("skips non-parseable lines without crashing", async () => {
    const lines = [
      "not valid json",
      JSON.stringify({ type: "ping" }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Grep", input: { pattern: "foo" } }],
        },
      }),
    ];
    writeFileSync(logFile, lines.join("\n") + "\n");

    await streamTailer.startTailing(4, logFile);
    await new Promise((r) => setTimeout(r, 100));

    // Only the Grep tool_use should have been emitted
    expect(emittedEvents.length).toBe(1);
    expect((emittedEvents[0].event as { name: string }).name).toBe("Grep");
  });

  it("stops tailing when stopTailing is called", async () => {
    await streamTailer.startTailing(5, logFile);
    streamTailer.stopTailing(5);

    // Append after stop — should NOT be picked up
    appendFileSync(
      logFile,
      JSON.stringify({
        result: "Done",
        is_error: false,
        num_turns: 1,
        cost_usd: 0,
        duration_ms: 0,
      }) + "\n",
    );

    await new Promise((r) => setTimeout(r, 300));

    const postStopEvents = emittedEvents.filter((e) => e.cardId === 5);
    expect(postStopEvents.length).toBe(0);
  });

  it("replaces existing tailer when startTailing is called again", async () => {
    await streamTailer.startTailing(6, logFile);

    // Start again with same cardId — should not error
    const logFile2 = join(testDir, "test2.ndjson");
    writeFileSync(
      logFile2,
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "from second file" }],
        },
      }) + "\n",
    );

    await streamTailer.startTailing(6, logFile2);
    await new Promise((r) => setTimeout(r, 100));

    const textEvents = emittedEvents.filter((e) => (e.event as { kind: string }).kind === "text");
    expect(textEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("includes timestamp in emitted events", async () => {
    const before = Date.now();
    writeFileSync(
      logFile,
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      }) + "\n",
    );

    await streamTailer.startTailing(7, logFile);
    await new Promise((r) => setTimeout(r, 100));

    expect(emittedEvents.length).toBe(1);
    expect(emittedEvents[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(emittedEvents[0].timestamp).toBeLessThanOrEqual(Date.now());
  });
});
