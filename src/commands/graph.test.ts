/**
 * Tests for graph command --days filtering and bar chart data
 */
import { describe, it, expect } from "vitest";
import { calculateCutoffMs, filterByDays, analyzeSession } from "./graph.js";

describe("graph --days filtering", () => {
  describe("calculateCutoffMs", () => {
    it("returns 0 when days <= 0", () => {
      expect(calculateCutoffMs(0)).toBe(0);
      expect(calculateCutoffMs(-1)).toBe(0);
    });

    it("returns cutoff timestamp for positive days", () => {
      const now = Date.now();
      const cutoff = calculateCutoffMs(7);
      // Should be roughly 7 days ago (within 100ms tolerance for test execution time)
      const expected = now - 7 * 24 * 60 * 60 * 1000;
      expect(Math.abs(cutoff - expected)).toBeLessThan(100);
    });
  });

  describe("filterByDays", () => {
    it("filters sessions older than N days when days > 0", () => {
      const now = Date.now();
      const sessions = [
        { mtime: now - 1 * 24 * 60 * 60 * 1000 }, // 1 day ago - included
        { mtime: now - 2 * 24 * 60 * 60 * 1000 }, // 2 days ago - included
        { mtime: now - 5 * 24 * 60 * 60 * 1000 }, // 5 days ago - excluded
        { mtime: now - 10 * 24 * 60 * 60 * 1000 }, // 10 days ago - excluded
      ];

      const filtered = filterByDays(sessions, 3);
      expect(filtered).toHaveLength(2);
    });

    it("returns all sessions when days=0", () => {
      const now = Date.now();
      const sessions = [
        { mtime: now - 1 * 24 * 60 * 60 * 1000 },
        { mtime: now - 100 * 24 * 60 * 60 * 1000 },
        { mtime: now - 365 * 24 * 60 * 60 * 1000 },
      ];

      const filtered = filterByDays(sessions, 0);
      expect(filtered).toHaveLength(3);
    });

    it("default 7 days filters correctly", () => {
      const now = Date.now();
      const sessions = [
        { mtime: now - 1 * 24 * 60 * 60 * 1000 }, // 1 day ago - included
        { mtime: now - 6 * 24 * 60 * 60 * 1000 }, // 6 days ago - included
        { mtime: now - 8 * 24 * 60 * 60 * 1000 }, // 8 days ago - excluded
        { mtime: now - 30 * 24 * 60 * 60 * 1000 }, // 30 days ago - excluded
      ];

      const filtered = filterByDays(sessions, 7);
      expect(filtered).toHaveLength(2);
      // Verify the right sessions were kept
      expect(filtered[0].mtime).toBeGreaterThan(now - 7 * 24 * 60 * 60 * 1000);
      expect(filtered[1].mtime).toBeGreaterThan(now - 7 * 24 * 60 * 60 * 1000);
    });

    it("--days 1 filters to today only", () => {
      const now = Date.now();
      const sessions = [
        { mtime: now - 12 * 60 * 60 * 1000 }, // 12 hours ago - included
        { mtime: now - 25 * 60 * 60 * 1000 }, // 25 hours ago - excluded
      ];

      const filtered = filterByDays(sessions, 1);
      expect(filtered).toHaveLength(1);
    });

    it("preserves additional properties on items", () => {
      const now = Date.now();
      const sessions = [
        { mtime: now, sessionId: "abc", tokens: 100 },
        { mtime: now - 10 * 24 * 60 * 60 * 1000, sessionId: "old", tokens: 50 },
      ];

      const filtered = filterByDays(sessions, 7);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].sessionId).toBe("abc");
      expect(filtered[0].tokens).toBe(100);
    });
  });
});

describe("analyzeSession (bar chart token aggregation)", () => {
  // Helper to create JournalEntry with message.usage structure
  function makeEntry(model: string, inputTokens: number, outputTokens: number) {
    return {
      type: "assistant",
      sessionId: "test-session",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant" as const,
        model,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      },
    };
  }

  it("returns zeros for empty entries array", () => {
    const result = analyzeSession([]);
    expect(result.opusTokens).toBe(0);
    expect(result.sonnetTokens).toBe(0);
    expect(result.haikuTokens).toBe(0);
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it("aggregates Opus tokens correctly", () => {
    const entries = [
      makeEntry("claude-opus-4-20250514", 100, 50),
      makeEntry("claude-opus-4-20250514", 200, 100),
    ];
    const result = analyzeSession(entries);
    expect(result.opusTokens).toBe(450); // 100+50+200+100
    expect(result.sonnetTokens).toBe(0);
    expect(result.haikuTokens).toBe(0);
  });

  it("aggregates Sonnet tokens correctly", () => {
    const entries = [makeEntry("claude-sonnet-4-20250514", 500, 200)];
    const result = analyzeSession(entries);
    expect(result.sonnetTokens).toBe(700);
    expect(result.opusTokens).toBe(0);
    expect(result.haikuTokens).toBe(0);
  });

  it("aggregates Haiku tokens correctly", () => {
    const entries = [makeEntry("claude-3-5-haiku-20241022", 1000, 500)];
    const result = analyzeSession(entries);
    expect(result.haikuTokens).toBe(1500);
    expect(result.opusTokens).toBe(0);
    expect(result.sonnetTokens).toBe(0);
  });

  it("aggregates mixed model tokens correctly", () => {
    const entries = [
      makeEntry("claude-opus-4-20250514", 100, 50),
      makeEntry("claude-sonnet-4-20250514", 200, 100),
      makeEntry("claude-3-5-haiku-20241022", 300, 150),
    ];
    const result = analyzeSession(entries);
    expect(result.opusTokens).toBe(150);
    expect(result.sonnetTokens).toBe(300);
    expect(result.haikuTokens).toBe(450);
    expect(result.inputTokens).toBe(600);
    expect(result.outputTokens).toBe(300);
  });

  it("ignores entries without message.usage", () => {
    const entries = [
      { type: "user", sessionId: "x", timestamp: "", message: { role: "user" as const } },
      makeEntry("claude-opus-4-20250514", 100, 50),
      { type: "tool_result", sessionId: "x", timestamp: "" },
    ];
    const result = analyzeSession(entries);
    expect(result.opusTokens).toBe(150);
  });

  it("calculates modelEfficiency as opus ratio", () => {
    const entries = [
      makeEntry("claude-opus-4-20250514", 100, 100),
      makeEntry("claude-sonnet-4-20250514", 200, 200),
    ];
    const result = analyzeSession(entries);
    // Opus: 200, Sonnet: 400, Total: 600
    // modelEfficiency = 200/600 = 0.333...
    expect(result.modelEfficiency).toBeCloseTo(0.333, 2);
  });
});
