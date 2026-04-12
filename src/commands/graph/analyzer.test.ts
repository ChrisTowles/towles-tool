import { describe, expect, it } from "vitest";
import type { ContentBlock, JournalEntry } from "./types";
import type { Usage } from "@anthropic-ai/sdk/resources/messages/messages";
import {
  aggregateSessionTools,
  analyzeSession,
  extractProjectName,
  getModelName,
  getPrimaryModel,
} from "./analyzer";
import { extractSessionLabel } from "./labels";
import { extractToolData, extractToolDetail, sanitizeString, truncateDetail } from "./tools";

// ── Helpers ──

let toolIdCounter = 0;

function textBlock(text: string): ContentBlock {
  return { type: "text" as const, text, citations: null };
}

function toolUseBlock(name: string, input: Record<string, unknown>): ContentBlock {
  return { type: "tool_use" as const, id: `tool-${++toolIdCounter}`, name, input };
}

function makeUsage(overrides: Partial<Usage> = {}): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
    server_tool_use: null,
    service_tier: null,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    type: "assistant",
    sessionId: "test-session",
    timestamp: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeAssistantEntry(
  model: string,
  inputTokens: number,
  outputTokens: number,
  content?: ContentBlock[],
  extra?: Partial<JournalEntry["message"]>,
): JournalEntry {
  return makeEntry({
    type: "assistant",
    message: {
      role: "assistant",
      model,
      usage: makeUsage({ input_tokens: inputTokens, output_tokens: outputTokens }),
      content: content ?? [textBlock("response")],
      ...extra,
    },
  });
}

// ── analyzeSession ──

describe("analyzeSession", () => {
  it("returns zeros for empty entries", () => {
    const result = analyzeSession([]);
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.opusTokens).toBe(0);
    expect(result.sonnetTokens).toBe(0);
    expect(result.haikuTokens).toBe(0);
    expect(result.cacheHitRate).toBe(0);
    expect(result.repeatedReads).toBe(0);
    expect(result.modelEfficiency).toBe(0);
  });

  it("counts tokens by model", () => {
    const entries = [
      makeAssistantEntry("claude-opus-4", 100, 50),
      makeAssistantEntry("claude-sonnet-4", 200, 100),
      makeAssistantEntry("claude-haiku-3", 50, 25),
    ];
    const result = analyzeSession(entries);
    expect(result.inputTokens).toBe(350);
    expect(result.outputTokens).toBe(175);
    expect(result.opusTokens).toBe(150);
    expect(result.sonnetTokens).toBe(300);
    expect(result.haikuTokens).toBe(75);
  });

  it("calculates cache hit rate", () => {
    const entries = [
      makeEntry({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-opus-4",
          usage: makeUsage({ input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 800 }),
          content: [textBlock("hi")],
        },
      }),
    ];
    const result = analyzeSession(entries);
    expect(result.cacheHitRate).toBe(0.8);
  });

  it("counts repeated file reads", () => {
    const content: ContentBlock[] = [
      toolUseBlock("Read", { file_path: "/a.ts" }),
      toolUseBlock("Read", { file_path: "/a.ts" }),
      toolUseBlock("Read", { file_path: "/b.ts" }),
    ];
    const entries = [makeAssistantEntry("claude-opus-4", 100, 50, content)];
    const result = analyzeSession(entries);
    expect(result.repeatedReads).toBe(1); // /a.ts read twice => 1 repeated
  });

  it("calculates model efficiency as opus fraction", () => {
    const entries = [
      makeAssistantEntry("claude-opus-4", 400, 100), // 500 opus
      makeAssistantEntry("claude-sonnet-4", 400, 100), // 500 sonnet
    ];
    const result = analyzeSession(entries);
    expect(result.modelEfficiency).toBe(0.5);
  });

  it("skips entries without usage", () => {
    const entries = [makeEntry({ message: { role: "assistant", content: "text" } })];
    const result = analyzeSession(entries);
    expect(result.inputTokens).toBe(0);
  });
});

// ── extractSessionLabel ──

describe("extractSessionLabel", () => {
  it("uses first user text message", () => {
    const entries = [
      makeEntry({
        type: "user",
        message: { role: "user", content: "Fix the bug in parser" },
      }),
    ];
    expect(extractSessionLabel(entries, "abc12345")).toBe("Fix the bug in parser");
  });

  it("skips UUID-only user messages", () => {
    const entries = [
      makeEntry({
        type: "user",
        message: { role: "user", content: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" },
      }),
      makeEntry({
        type: "user",
        message: { role: "user", content: "Real message" },
      }),
    ];
    expect(extractSessionLabel(entries, "abc12345")).toBe("Real message");
  });

  it("extracts text from array content blocks", () => {
    const entries = [
      makeEntry({
        type: "user",
        message: {
          role: "user",
          content: [textBlock("Array content message")],
        },
      }),
    ];
    expect(extractSessionLabel(entries, "abc12345")).toBe("Array content message");
  });

  it("falls back to assistant text", () => {
    const entries = [
      makeEntry({
        type: "assistant",
        message: {
          role: "assistant",
          content: [textBlock("I'll help you with that")],
        },
      }),
    ];
    expect(extractSessionLabel(entries, "abc12345")).toBe("I'll help you with that");
  });

  it("falls back to gitBranch", () => {
    const entries = [makeEntry({ type: "user" })];
    entries[0].gitBranch = "feat/new-feature";
    expect(extractSessionLabel(entries, "abc12345")).toBe("feat/new-feature");
  });

  it("falls back to short session ID", () => {
    expect(extractSessionLabel([], "abc12345-long-id")).toBe("abc12345");
  });

  it("removes /command prefixes", () => {
    const entries = [
      makeEntry({
        type: "user",
        message: { role: "user", content: "/review Fix the parser" },
      }),
    ];
    expect(extractSessionLabel(entries, "abc12345")).toBe("Fix the parser");
  });

  it("removes XML tags", () => {
    const entries = [
      makeEntry({
        type: "user",
        message: { role: "user", content: "<tag>content</tag> Real text" },
      }),
    ];
    expect(extractSessionLabel(entries, "abc12345")).toBe("Real text");
  });

  it("truncates labels longer than 80 chars", () => {
    const longText = "A".repeat(100);
    const entries = [
      makeEntry({
        type: "user",
        message: { role: "user", content: longText },
      }),
    ];
    const label = extractSessionLabel(entries, "abc12345");
    expect(label.length).toBe(80);
    expect(label.endsWith("...")).toBe(true);
  });

  it("uses slug fallback for short labels after cleanup", () => {
    const entries = [makeEntry()];
    entries[0].slug = "my-slug";
    expect(extractSessionLabel(entries, "abc12345")).toBe("my-slug");
  });
});

// ── sanitizeString ──

describe("sanitizeString", () => {
  it("replaces control characters with space", () => {
    expect(sanitizeString("hello\nworld\ttab")).toBe("hello world tab");
  });

  it("trims result", () => {
    expect(sanitizeString("  hello  ")).toBe("hello");
  });

  it("collapses multiple control chars", () => {
    expect(sanitizeString("a\n\n\nb")).toBe("a b");
  });

  it("handles empty string", () => {
    expect(sanitizeString("")).toBe("");
  });
});

// ── truncateDetail ──

describe("truncateDetail", () => {
  it("returns undefined for undefined input", () => {
    expect(truncateDetail(undefined)).toBeUndefined();
  });

  it("returns short strings unchanged", () => {
    expect(truncateDetail("hello")).toBe("hello");
  });

  it("truncates long strings with ellipsis", () => {
    const long = "A".repeat(40);
    const result = truncateDetail(long, 30);
    expect(result?.length).toBe(30);
    expect(result?.endsWith("...")).toBe(true);
  });

  it("extracts filename from paths", () => {
    expect(truncateDetail("/home/user/project/file.ts")).toBe("file.ts");
  });

  it("truncates long filenames", () => {
    const longFile = "/path/" + "A".repeat(40) + ".ts";
    const result = truncateDetail(longFile, 30);
    expect(result?.length).toBe(30);
    expect(result?.endsWith("...")).toBe(true);
  });
});

// ── extractToolDetail ──

describe("extractToolDetail", () => {
  it("returns undefined when no input", () => {
    expect(extractToolDetail("Read")).toBeUndefined();
  });

  it("extracts file_path for Read", () => {
    expect(extractToolDetail("Read", { file_path: "/src/index.ts" })).toBe("index.ts");
  });

  it("extracts file_path for Write", () => {
    expect(extractToolDetail("Write", { file_path: "/src/utils.ts" })).toBe("utils.ts");
  });

  it("extracts file_path for Edit", () => {
    expect(extractToolDetail("Edit", { file_path: "/src/edit.ts" })).toBe("edit.ts");
  });

  it("extracts command for Bash", () => {
    expect(extractToolDetail("Bash", { command: "pnpm test" })).toBe("pnpm test");
  });

  it("extracts pattern for Glob", () => {
    // Pattern contains "/" so truncateDetail extracts the last segment
    expect(extractToolDetail("Glob", { pattern: "**/*.ts" })).toBe("*.ts");
  });

  it("extracts pattern for Grep", () => {
    expect(extractToolDetail("Grep", { pattern: "TODO" })).toBe("TODO");
  });

  it("returns undefined for unknown tools", () => {
    expect(extractToolDetail("CustomTool", { foo: "bar" })).toBeUndefined();
  });
});

// ── extractToolData ──

describe("extractToolData", () => {
  it("returns empty for undefined content", () => {
    expect(extractToolData(undefined, 100, 50)).toEqual([]);
  });

  it("returns empty for string content", () => {
    expect(extractToolData("text", 100, 50)).toEqual([]);
  });

  it("returns empty when no tool_use blocks", () => {
    const content: ContentBlock[] = [textBlock("hello")];
    expect(extractToolData(content, 100, 50)).toEqual([]);
  });

  it("extracts tool calls and distributes tokens", () => {
    const content: ContentBlock[] = [
      toolUseBlock("Read", { file_path: "/a.ts" }),
      toolUseBlock("Bash", { command: "ls" }),
    ];
    const result = extractToolData(content, 200, 100);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("Read");
    expect(result[0].inputTokens).toBe(100);
    expect(result[0].outputTokens).toBe(50);
    expect(result[1].name).toBe("Bash");
    expect(result[1].inputTokens).toBe(100);
  });
});

// ── aggregateSessionTools ──

describe("aggregateSessionTools", () => {
  it("returns empty for no entries", () => {
    expect(aggregateSessionTools([])).toEqual([]);
  });

  it("aggregates tools across entries", () => {
    const entries = [
      makeAssistantEntry("claude-opus-4", 100, 50, [toolUseBlock("Read", { file_path: "/a.ts" })]),
      makeAssistantEntry("claude-opus-4", 200, 100, [
        toolUseBlock("Read", { file_path: "/b.ts" }),
        toolUseBlock("Bash", { command: "ls" }),
      ]),
    ];
    const result = aggregateSessionTools(entries);
    const readTool = result.find((t) => t.name === "Read");
    expect(readTool).toBeDefined();
    expect(readTool?.detail).toBe("2x");
  });

  it("sorts by total token usage descending", () => {
    const entries = [
      makeAssistantEntry("claude-opus-4", 100, 50, [toolUseBlock("Bash", { command: "ls" })]),
      makeAssistantEntry("claude-opus-4", 1000, 500, [
        toolUseBlock("Read", { file_path: "/a.ts" }),
      ]),
    ];
    const result = aggregateSessionTools(entries);
    expect(result[0].name).toBe("Read");
  });
});

// ── getPrimaryModel ──

describe("getPrimaryModel", () => {
  it("returns Opus when opus has most tokens", () => {
    expect(getPrimaryModel({ opusTokens: 100, sonnetTokens: 50, haikuTokens: 10 })).toBe("Opus");
  });

  it("returns Sonnet when sonnet dominates", () => {
    expect(getPrimaryModel({ opusTokens: 10, sonnetTokens: 500, haikuTokens: 10 })).toBe("Sonnet");
  });

  it("returns Haiku when haiku dominates", () => {
    expect(getPrimaryModel({ opusTokens: 0, sonnetTokens: 0, haikuTokens: 100 })).toBe("Haiku");
  });

  it("returns Opus on tie between opus and sonnet", () => {
    expect(getPrimaryModel({ opusTokens: 100, sonnetTokens: 100, haikuTokens: 0 })).toBe("Opus");
  });

  it("returns Opus when all zero", () => {
    expect(getPrimaryModel({ opusTokens: 0, sonnetTokens: 0, haikuTokens: 0 })).toBe("Opus");
  });
});

// ── getModelName ──

describe("getModelName", () => {
  it("returns 'unknown' for undefined", () => {
    expect(getModelName()).toBe("unknown");
  });

  it("returns Opus for opus models", () => {
    expect(getModelName("claude-opus-4-20250514")).toBe("Opus");
  });

  it("returns Sonnet for sonnet models", () => {
    expect(getModelName("claude-sonnet-4-20250514")).toBe("Sonnet");
  });

  it("returns Haiku for haiku models", () => {
    expect(getModelName("claude-3-haiku")).toBe("Haiku");
  });

  it("returns first segment for unknown models", () => {
    expect(getModelName("gpt-4-turbo")).toBe("gpt");
  });

  it("returns 'unknown' for empty string", () => {
    expect(getModelName("")).toBe("unknown");
  });
});

// ── extractProjectName ──

describe("extractProjectName", () => {
  it("extracts project name after path markers", () => {
    expect(extractProjectName("-home-ctowles-code-p-towles-tool")).toBe("towles-tool");
  });

  it("handles 'projects' marker", () => {
    expect(extractProjectName("-home-user-projects-my-app")).toBe("my-app");
  });

  it("handles 'src' marker", () => {
    expect(extractProjectName("-home-user-src-cool-lib")).toBe("cool-lib");
  });

  it("uses last two parts when no marker found", () => {
    expect(extractProjectName("-foo-bar-baz")).toBe("bar-baz");
  });

  it("handles single segment after marker", () => {
    expect(extractProjectName("-home-user-code-myproject")).toBe("myproject");
  });

  it("uses last marker when multiple exist", () => {
    expect(extractProjectName("-home-code-old-src-new-project")).toBe("new-project");
  });
});
