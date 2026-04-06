import { describe, it, expect } from "bun:test";
import { determineStatus } from "./claude-code";

describe("determineStatus", () => {
  it("returns null when no message", () => {
    expect(determineStatus({})).toBeNull();
    expect(determineStatus({ message: undefined })).toBeNull();
  });

  it("returns null when message has no role", () => {
    expect(determineStatus({ message: { content: "hi" } })).toBeNull();
  });

  it('returns "running" for user messages', () => {
    expect(determineStatus({ message: { role: "user", content: "hello" } })).toBe("running");
  });

  it('returns "running" for assistant messages with tool_use', () => {
    expect(
      determineStatus({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Let me check that." }, { type: "tool_use" }],
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

  it("returns null for unknown roles", () => {
    expect(
      determineStatus({
        message: { role: "system", content: "system message" },
      }),
    ).toBeNull();
  });
});
