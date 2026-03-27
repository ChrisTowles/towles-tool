import { describe, it, expect } from "vitest";
import { parseStreamLine } from "../../server/domains/infra/stream-parser";

describe("parseStreamLine", () => {
  it("returns null for empty lines", () => {
    expect(parseStreamLine("")).toBeNull();
    expect(parseStreamLine("   ")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseStreamLine("not json")).toBeNull();
    expect(parseStreamLine("{broken")).toBeNull();
  });

  it("returns null for unrecognized event types", () => {
    expect(parseStreamLine(JSON.stringify({ type: "ping" }))).toBeNull();
    expect(parseStreamLine(JSON.stringify({ type: "system", data: {} }))).toBeNull();
  });

  describe("result events", () => {
    it("parses a result event", () => {
      const line = JSON.stringify({
        result: "Task completed successfully",
        is_error: false,
        num_turns: 5,
        cost_usd: 0.0342,
        duration_ms: 12000,
      });

      const event = parseStreamLine(line);
      expect(event).toEqual({
        kind: "result",
        costUsd: 0.0342,
        durationMs: 12000,
        numTurns: 5,
        isError: false,
      });
    });

    it("parses an error result", () => {
      const line = JSON.stringify({
        result: "Failed",
        is_error: true,
        num_turns: 1,
        cost_usd: 0.001,
        duration_ms: 500,
      });

      const event = parseStreamLine(line);
      expect(event).toEqual({
        kind: "result",
        costUsd: 0.001,
        durationMs: 500,
        numTurns: 1,
        isError: true,
      });
    });

    it("defaults cost to 0 when missing", () => {
      const line = JSON.stringify({
        result: "done",
        is_error: false,
        num_turns: 3,
      });

      const event = parseStreamLine(line);
      expect(event?.kind).toBe("result");
      if (event?.kind === "result") {
        expect(event.costUsd).toBe(0);
        expect(event.durationMs).toBe(0);
      }
    });

    it("handles total_cost_usd field name", () => {
      const line = JSON.stringify({
        result: "done",
        is_error: false,
        num_turns: 2,
        total_cost_usd: 0.05,
      });

      const event = parseStreamLine(line);
      if (event?.kind === "result") {
        expect(event.costUsd).toBe(0.05);
      }
    });
  });

  describe("stream_event tool_use", () => {
    it("parses a tool_use event with file_path input", () => {
      const line = JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: {
            type: "tool_use",
            name: "Read",
            input: { file_path: "/home/user/code/main.ts" },
          },
        },
      });

      const event = parseStreamLine(line);
      expect(event).toEqual({
        kind: "tool_use",
        name: "Read",
        detail: "/home/user/code/main.ts",
        input: { file_path: "/home/user/code/main.ts" },
      });
    });

    it("parses Edit tool with old/new string detail", () => {
      const line = JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: {
            type: "tool_use",
            name: "Edit",
            input: {
              file_path: "src/index.ts",
              old_string: "const x = 1;",
              new_string: "const x = 2;",
            },
          },
        },
      });

      const event = parseStreamLine(line);
      expect(event?.kind).toBe("tool_use");
      if (event?.kind === "tool_use") {
        expect(event.name).toBe("Edit");
        expect(event.detail).toContain("src/index.ts");
        expect(event.detail).toContain('"const x = 1;"');
        expect(event.detail).toContain('"const x = 2;"');
      }
    });

    it("parses Bash tool with command detail", () => {
      const line = JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: {
            type: "tool_use",
            name: "Bash",
            input: { command: "pnpm test" },
          },
        },
      });

      const event = parseStreamLine(line);
      if (event?.kind === "tool_use") {
        expect(event.name).toBe("Bash");
        expect(event.detail).toBe("pnpm test");
      }
    });

    it("parses Grep tool with pattern detail", () => {
      const line = JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: {
            type: "tool_use",
            name: "Grep",
            input: { pattern: "parseStreamLine" },
          },
        },
      });

      const event = parseStreamLine(line);
      if (event?.kind === "tool_use") {
        expect(event.name).toBe("Grep");
        expect(event.detail).toBe("parseStreamLine");
      }
    });

    it("returns empty detail for tool with no recognized input fields", () => {
      const line = JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: {
            type: "tool_use",
            name: "CustomTool",
            input: { some_field: "value" },
          },
        },
      });

      const event = parseStreamLine(line);
      if (event?.kind === "tool_use") {
        expect(event.detail).toBe("");
      }
    });

    it("handles tool_use with no input", () => {
      const line = JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: {
            type: "tool_use",
            name: "SomeTool",
          },
        },
      });

      const event = parseStreamLine(line);
      if (event?.kind === "tool_use") {
        expect(event.input).toEqual({});
        expect(event.detail).toBe("");
      }
    });
  });

  describe("stream_event thinking", () => {
    it("parses a thinking event", () => {
      const line = JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: {
            type: "thinking",
            thinking: "I need to read the file first to understand the structure.",
          },
        },
      });

      const event = parseStreamLine(line);
      expect(event).toEqual({
        kind: "thinking",
        summary: "I need to read the file first to understand the structure.",
      });
    });

    it("truncates long thinking to 120 chars", () => {
      const longThinking = "A".repeat(200);
      const line = JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: {
            type: "thinking",
            thinking: longThinking,
          },
        },
      });

      const event = parseStreamLine(line);
      if (event?.kind === "thinking") {
        expect(event.summary.length).toBeLessThanOrEqual(121); // 120 + ellipsis
        expect(event.summary).toContain("…");
      }
    });

    it("uses only first line of multi-line thinking", () => {
      const line = JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: {
            type: "thinking",
            thinking: "First line\nSecond line\nThird line",
          },
        },
      });

      const event = parseStreamLine(line);
      if (event?.kind === "thinking") {
        expect(event.summary).toBe("First line");
      }
    });

    it("handles empty thinking", () => {
      const line = JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: { type: "thinking" },
        },
      });

      const event = parseStreamLine(line);
      if (event?.kind === "thinking") {
        expect(event.summary).toBe("");
      }
    });
  });

  describe("stream_event text", () => {
    it("parses a text event", () => {
      const line = JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: {
            type: "text",
            text: "Here is the implementation plan:",
          },
        },
      });

      const event = parseStreamLine(line);
      expect(event).toEqual({
        kind: "text",
        content: "Here is the implementation plan:",
      });
    });
  });

  describe("assistant message format", () => {
    it("parses tool_use from assistant message content array", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Write",
              input: { file_path: "/tmp/test.ts", content: "hello" },
            },
          ],
        },
      });

      const event = parseStreamLine(line);
      expect(event?.kind).toBe("tool_use");
      if (event?.kind === "tool_use") {
        expect(event.name).toBe("Write");
        expect(event.detail).toBe("/tmp/test.ts");
      }
    });

    it("parses thinking from assistant message content array", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "thinking", thinking: "Let me think about this" }],
        },
      });

      const event = parseStreamLine(line);
      expect(event).toEqual({
        kind: "thinking",
        summary: "Let me think about this",
      });
    });

    it("parses text from assistant message content array", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "I will now implement the feature." }],
        },
      });

      const event = parseStreamLine(line);
      expect(event).toEqual({
        kind: "text",
        content: "I will now implement the feature.",
      });
    });

    it("returns null for empty content array", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: { content: [] },
      });

      expect(parseStreamLine(line)).toBeNull();
    });
  });

  describe("ignores non-interesting events", () => {
    it("ignores content_block_delta", () => {
      const line = JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "partial" },
        },
      });

      expect(parseStreamLine(line)).toBeNull();
    });

    it("ignores message_start", () => {
      const line = JSON.stringify({
        type: "stream_event",
        event: { type: "message_start", message: {} },
      });

      expect(parseStreamLine(line)).toBeNull();
    });

    it("ignores message_stop", () => {
      const line = JSON.stringify({
        type: "stream_event",
        event: { type: "message_stop" },
      });

      expect(parseStreamLine(line)).toBeNull();
    });
  });
});
