import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { calculateCutoffMs, filterByDays, parseJsonl, quickTokenCount } from "./parser";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

const mockedReadFileSync = vi.mocked(fs.readFileSync);

// ── Pure functions (no mocking needed) ──

describe("calculateCutoffMs", () => {
  it("returns 0 for days <= 0", () => {
    expect(calculateCutoffMs(0)).toBe(0);
    expect(calculateCutoffMs(-1)).toBe(0);
  });

  it("returns a timestamp in the past for positive days", () => {
    const now = Date.now();
    const cutoff = calculateCutoffMs(7);
    const expectedApprox = now - 7 * 24 * 60 * 60 * 1000;
    // Allow 100ms tolerance for execution time
    expect(Math.abs(cutoff - expectedApprox)).toBeLessThan(100);
  });

  it("returns larger cutoff for more days", () => {
    const cutoff7 = calculateCutoffMs(7);
    const cutoff30 = calculateCutoffMs(30);
    expect(cutoff30).toBeLessThan(cutoff7); // Further in the past
  });
});

describe("filterByDays", () => {
  const now = Date.now();
  const items = [
    { mtime: now - 1 * 24 * 60 * 60 * 1000, name: "1-day-ago" },
    { mtime: now - 5 * 24 * 60 * 60 * 1000, name: "5-days-ago" },
    { mtime: now - 10 * 24 * 60 * 60 * 1000, name: "10-days-ago" },
    { mtime: now - 20 * 24 * 60 * 60 * 1000, name: "20-days-ago" },
  ];

  it("returns all items when days <= 0", () => {
    expect(filterByDays(items, 0)).toEqual(items);
    expect(filterByDays(items, -5)).toEqual(items);
  });

  it("filters items older than cutoff", () => {
    const result = filterByDays(items, 7);
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.name)).toEqual(["1-day-ago", "5-days-ago"]);
  });

  it("returns empty array when all items are too old", () => {
    const result = filterByDays(items, 0.001); // ~86ms
    expect(result).toHaveLength(0);
  });

  it("returns all items when cutoff is very large", () => {
    const result = filterByDays(items, 365);
    expect(result).toHaveLength(4);
  });

  it("handles empty array", () => {
    expect(filterByDays([], 7)).toEqual([]);
  });
});

// ── parseJsonl and quickTokenCount (require fs mock) ──

describe("parseJsonl", () => {
  it("parses valid JSONL lines", () => {
    mockedReadFileSync.mockReturnValue(
      '{"type":"user","sessionId":"s1","timestamp":"2025-01-01T00:00:00Z"}\n{"type":"assistant","sessionId":"s1","timestamp":"2025-01-01T00:01:00Z"}\n',
    );
    const entries = parseJsonl("/fake/path.jsonl");
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe("user");
    expect(entries[1].type).toBe("assistant");
  });

  it("skips empty lines", () => {
    mockedReadFileSync.mockReturnValue(
      '{"type":"user","sessionId":"s1","timestamp":"t"}\n\n\n{"type":"assistant","sessionId":"s1","timestamp":"t"}\n',
    );
    const entries = parseJsonl("/fake/path.jsonl");
    expect(entries).toHaveLength(2);
  });

  it("skips invalid JSON lines", () => {
    mockedReadFileSync.mockReturnValue(
      '{"type":"user","sessionId":"s1","timestamp":"t"}\nnot-json\n{"type":"assistant","sessionId":"s1","timestamp":"t"}\n',
    );
    const entries = parseJsonl("/fake/path.jsonl");
    expect(entries).toHaveLength(2);
  });

  it("returns empty array for empty file", () => {
    mockedReadFileSync.mockReturnValue("");
    const entries = parseJsonl("/fake/path.jsonl");
    expect(entries).toHaveLength(0);
  });
});

describe("quickTokenCount", () => {
  it("sums input and output tokens from entries with usage", () => {
    const lines = [
      JSON.stringify({
        message: { usage: { input_tokens: 100, output_tokens: 50 } },
      }),
      JSON.stringify({
        message: { usage: { input_tokens: 200, output_tokens: 75 } },
      }),
    ].join("\n");
    mockedReadFileSync.mockReturnValue(lines);
    expect(quickTokenCount("/fake/path.jsonl")).toBe(425);
  });

  it("skips entries without usage", () => {
    const lines = [
      JSON.stringify({ message: { content: "text" } }),
      JSON.stringify({ message: { usage: { input_tokens: 100, output_tokens: 50 } } }),
    ].join("\n");
    mockedReadFileSync.mockReturnValue(lines);
    expect(quickTokenCount("/fake/path.jsonl")).toBe(150);
  });

  it("returns 0 for unreadable files", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(quickTokenCount("/missing/file.jsonl")).toBe(0);
  });

  it("handles entries with partial usage (only input_tokens)", () => {
    const lines = JSON.stringify({
      message: { usage: { input_tokens: 100 } },
    });
    mockedReadFileSync.mockReturnValue(lines);
    expect(quickTokenCount("/fake/path.jsonl")).toBe(100);
  });

  it("skips invalid JSON lines gracefully", () => {
    mockedReadFileSync.mockReturnValue(
      '{"message":{"usage":{"input_tokens":50,"output_tokens":50}}}\nbadline\n',
    );
    expect(quickTokenCount("/fake/path.jsonl")).toBe(100);
  });
});
