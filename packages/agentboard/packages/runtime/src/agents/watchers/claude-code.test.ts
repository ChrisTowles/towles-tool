import { describe, it, expect } from "bun:test";
import { determineStatus } from "./claude-code";

describe("determineStatus", () => {
  it('returns "idle" when no message', () => {
    expect(determineStatus({})).toBe("idle");
    expect(determineStatus({ message: undefined })).toBe("idle");
  });

  it('returns "idle" when message has no role', () => {
    expect(determineStatus({ message: { content: "hi" } })).toBe("idle");
  });

  it('returns "running" for user messages', () => {
    expect(determineStatus({ message: { role: "user", content: "hello" } })).toBe("running");
  });

  it('returns "running" for assistant messages with tool_use', () => {
    expect(
      determineStatus({
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check that." },
            { type: "tool_use" },
          ],
        },
      }),
    ).toBe("running");
  });

  it('returns "done" for assistant messages without tool_use', () => {
    expect(
      determineStatus({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is the answer." }],
        },
      }),
    ).toBe("done");
  });

  it('returns "done" for assistant messages with string content', () => {
    expect(
      determineStatus({
        message: { role: "assistant", content: "plain text response" },
      }),
    ).toBe("done");
  });

  it('returns "done" for assistant messages with empty content', () => {
    expect(
      determineStatus({
        message: { role: "assistant", content: [] },
      }),
    ).toBe("done");
  });

  it('returns "idle" for unknown roles', () => {
    expect(
      determineStatus({
        message: { role: "system", content: "system message" },
      }),
    ).toBe("idle");
  });
});
