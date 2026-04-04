import { describe, expect, it } from "vitest";
import { formatCsv, formatJson } from "./format";
import type { SessionRow } from "./format";

// ── formatJson ──

describe("formatJson", () => {
  it("returns valid JSON for empty array", () => {
    const result = formatJson([]);
    expect(JSON.parse(result)).toEqual([]);
  });

  it("serializes session rows with all fields", () => {
    const rows: SessionRow[] = [
      {
        sessionPath: "/home/user/.claude/projects/test/abc123.jsonl",
        project: "my-project",
        model: "Opus",
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cost: 0.0525,
        date: "2025-06-15",
      },
    ];
    const parsed = JSON.parse(formatJson(rows));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].sessionPath).toBe("/home/user/.claude/projects/test/abc123.jsonl");
    expect(parsed[0].project).toBe("my-project");
    expect(parsed[0].model).toBe("Opus");
    expect(parsed[0].inputTokens).toBe(1000);
    expect(parsed[0].outputTokens).toBe(500);
    expect(parsed[0].totalTokens).toBe(1500);
    expect(parsed[0].cost).toBe(0.0525);
    expect(parsed[0].date).toBe("2025-06-15");
  });

  it("serializes multiple rows", () => {
    const rows: SessionRow[] = [
      {
        sessionPath: "/a.jsonl",
        project: "proj-a",
        model: "Opus",
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cost: 0.005,
        date: "2025-06-15",
      },
      {
        sessionPath: "/b.jsonl",
        project: "proj-b",
        model: "Sonnet",
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
        cost: 0.002,
        date: "2025-06-16",
      },
    ];
    const parsed = JSON.parse(formatJson(rows));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].project).toBe("proj-a");
    expect(parsed[1].project).toBe("proj-b");
  });
});

// ── formatCsv ──

describe("formatCsv", () => {
  it("returns header only for empty array", () => {
    const result = formatCsv([]);
    expect(result).toBe(
      "session_path,project,model,input_tokens,output_tokens,total_tokens,cost,date",
    );
  });

  it("formats rows with proper CSV quoting", () => {
    const rows: SessionRow[] = [
      {
        sessionPath: "/home/user/.claude/projects/test/abc123.jsonl",
        project: "my-project",
        model: "Opus",
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cost: 0.0525,
        date: "2025-06-15",
      },
    ];
    const lines = formatCsv(rows).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      "session_path,project,model,input_tokens,output_tokens,total_tokens,cost,date",
    );
    expect(lines[1]).toContain('"my-project"');
    expect(lines[1]).toContain("1000");
    expect(lines[1]).toContain("500");
    expect(lines[1]).toContain("1500");
    expect(lines[1]).toContain("0.0525");
    expect(lines[1]).toContain("2025-06-15");
  });

  it("formats multiple rows", () => {
    const rows: SessionRow[] = [
      {
        sessionPath: "/a.jsonl",
        project: "proj-a",
        model: "Opus",
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cost: 0.005,
        date: "2025-06-15",
      },
      {
        sessionPath: "/b.jsonl",
        project: "proj-b",
        model: "Sonnet",
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
        cost: 0.002,
        date: "2025-06-16",
      },
    ];
    const lines = formatCsv(rows).split("\n");
    expect(lines).toHaveLength(3);
  });
});
