import { describe, it, expect } from "bun:test";
import { determineStatus, summaryToDetails, extractLastTool } from "./claude-code";
import type { ClaudeUsageSummary } from "./claude-usage";

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

describe("summaryToDetails", () => {
  it("maps all fields including cache", () => {
    const s: ClaudeUsageSummary = {
      model: "claude-opus-4-6",
      contextUsed: 1000,
      contextMax: 200_000,
      cacheTtlMs: 300_000,
      cacheExpiresAt: 1_700_000_000_000,
      lastActivityAt: 1_699_999_700_000,
    };
    expect(summaryToDetails(s)).toEqual({
      model: "claude-opus-4-6",
      contextUsed: 1000,
      contextMax: 200_000,
      cacheTtlMs: 300_000,
      cacheExpiresAt: 1_700_000_000_000,
      lastActivityAt: 1_699_999_700_000,
    });
  });

  it("omits cache fields when null (converts to undefined)", () => {
    const s: ClaudeUsageSummary = {
      model: "claude-haiku-4-5",
      contextUsed: 500,
      contextMax: 200_000,
      cacheTtlMs: null,
      cacheExpiresAt: null,
      lastActivityAt: 1_700_000_000_000,
    };
    const details = summaryToDetails(s);
    expect(details.cacheTtlMs).toBeUndefined();
    expect(details.cacheExpiresAt).toBeUndefined();
    expect(details.model).toBe("claude-haiku-4-5");
  });
});

describe("extractLastTool", () => {
  it("returns undefined when no entries", () => {
    expect(extractLastTool([])).toBeUndefined();
  });

  it("returns undefined when no assistant tool_use entries", () => {
    expect(
      extractLastTool([
        { message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
        { message: { role: "user", content: "hi" } },
      ]),
    ).toBeUndefined();
  });

  it("returns tool name from the most recent assistant tool_use", () => {
    expect(
      extractLastTool([
        { message: { role: "assistant", content: [{ type: "tool_use", name: "Read" }] } },
      ]),
    ).toBe("Read");
  });

  it("prefers the latest entry when multiple tool_use present", () => {
    expect(
      extractLastTool([
        { message: { role: "assistant", content: [{ type: "tool_use", name: "Read" }] } },
        { message: { role: "user", content: "ok" } },
        { message: { role: "assistant", content: [{ type: "tool_use", name: "Edit" }] } },
      ]),
    ).toBe("Edit");
  });

  it("skips AskUserQuestion (not a real tool use for display)", () => {
    expect(
      extractLastTool([
        { message: { role: "assistant", content: [{ type: "tool_use", name: "Read" }] } },
        {
          message: {
            role: "assistant",
            content: [{ type: "tool_use", name: "AskUserQuestion" }],
          },
        },
      ]),
    ).toBe("Read");
  });

  it("returns the first tool name if a turn has multiple tool_use items", () => {
    expect(
      extractLastTool([
        {
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", name: "Read" },
              { type: "tool_use", name: "Grep" },
            ],
          },
        },
      ]),
    ).toBe("Read");
  });
});
