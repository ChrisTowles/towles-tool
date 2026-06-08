import { describe, it, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, utimes, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  determineStatus,
  summaryToDetails,
  extractLastTool,
  subagentSignature,
  readActiveSubagents,
  extractLoopState,
} from "./claude-code";
import type { ClaudeUsageSummary } from "./claude-usage";
import type { SubagentInfo } from "../../contracts/agent";

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

  it("returns undefined when only AskUserQuestion tool_use entries exist", () => {
    expect(
      extractLastTool([
        {
          message: {
            role: "assistant",
            content: [{ type: "tool_use", name: "AskUserQuestion" }],
          },
        },
      ]),
    ).toBeUndefined();
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

describe("extractLoopState", () => {
  const TS = "2026-06-08T21:00:00.000Z";
  const TS_MS = Date.parse(TS);

  const wakeup = (delaySeconds: number, reason?: string, ts = TS) => ({
    type: "assistant" as const,
    timestamp: ts,
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: "ScheduleWakeup", input: { delaySeconds, reason } }],
    },
  });

  it("returns undefined when no ScheduleWakeup present", () => {
    expect(
      extractLoopState([
        { message: { role: "assistant", content: [{ type: "tool_use", name: "Read" }] } },
      ]),
    ).toBeUndefined();
  });

  it("computes nextWakeAt from timestamp + delaySeconds and keeps the reason", () => {
    expect(extractLoopState([wakeup(240, "watch the deploy")])).toEqual({
      nextWakeAt: TS_MS + 240_000,
      reason: "watch the deploy",
    });
  });

  it("uses the most recent ScheduleWakeup when several exist", () => {
    const later = "2026-06-08T21:10:00.000Z";
    const result = extractLoopState([wakeup(60, "first"), wakeup(120, "second", later)]);
    expect(result).toEqual({ nextWakeAt: Date.parse(later) + 120_000, reason: "second" });
  });

  it("returns undefined when the entry has no parseable timestamp", () => {
    const w = wakeup(60, "x");
    w.timestamp = "not-a-date";
    expect(extractLoopState([w])).toBeUndefined();
  });

  it("ignores ScheduleWakeup that is not a tool_use (e.g. tool definition text)", () => {
    expect(
      extractLoopState([
        {
          timestamp: TS,
          message: { role: "assistant", content: [{ type: "text", text: "ScheduleWakeup" }] },
        },
      ]),
    ).toBeUndefined();
  });
});

describe("subagentSignature", () => {
  it("is empty for no sub-agents", () => {
    expect(subagentSignature([])).toBe("");
  });

  it("is order-independent", () => {
    const a: SubagentInfo[] = [
      { agentType: "Explore", description: "find code" },
      { agentType: "general-purpose", description: "fix bug" },
    ];
    const b: SubagentInfo[] = [
      { agentType: "general-purpose", description: "fix bug" },
      { agentType: "Explore", description: "find code" },
    ];
    expect(subagentSignature(a)).toBe(subagentSignature(b));
  });

  it("changes when an agent is added or removed", () => {
    const one: SubagentInfo[] = [{ agentType: "Explore", description: "find code" }];
    const two: SubagentInfo[] = [
      { agentType: "Explore", description: "find code" },
      { agentType: "Plan", description: "design" },
    ];
    expect(subagentSignature(one)).not.toBe(subagentSignature(two));
  });

  it("tolerates missing fields", () => {
    expect(subagentSignature([{}])).toBe(" ");
  });
});

describe("readActiveSubagents", () => {
  const NOW = 1_700_000_000_000;
  const ACTIVE_MTIME = NOW - 10_000; // 10s ago: well within the 2-min active window
  const STALE_MTIME = NOW - 5 * 60_000; // 5m ago: finished agent, should be excluded

  async function makeSubagentsDir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "agentboard-subagents-"));
    const dir = join(root, "subagents");
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async function writeAgent(
    dir: string,
    id: string,
    mtimeMs: number,
    meta?: { agentType?: string; description?: string },
  ): Promise<void> {
    const jsonl = join(dir, `agent-${id}.jsonl`);
    await writeFile(jsonl, '{"type":"user"}\n');
    if (meta) await writeFile(join(dir, `agent-${id}.meta.json`), JSON.stringify(meta));
    const sec = mtimeMs / 1000;
    await utimes(jsonl, sec, sec);
  }

  it("returns [] when the directory does not exist", async () => {
    expect(await readActiveSubagents(join(tmpdir(), "nope-does-not-exist-xyz"), NOW)).toEqual([]);
  });

  it("includes recently-active agents with meta", async () => {
    const dir = await makeSubagentsDir();
    try {
      await writeAgent(dir, "aaa", ACTIVE_MTIME, {
        agentType: "Explore",
        description: "find code",
      });
      const result = await readActiveSubagents(dir, NOW);
      expect(result).toEqual([{ agentType: "Explore", description: "find code" }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("excludes agents whose journal is stale (finished)", async () => {
    const dir = await makeSubagentsDir();
    try {
      await writeAgent(dir, "live", ACTIVE_MTIME, { agentType: "Explore" });
      await writeAgent(dir, "dead", STALE_MTIME, { agentType: "Plan" });
      const result = await readActiveSubagents(dir, NOW);
      expect(result).toEqual([{ agentType: "Explore", description: undefined }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("counts an agent even when its meta.json is missing", async () => {
    const dir = await makeSubagentsDir();
    try {
      await writeAgent(dir, "nometa", ACTIVE_MTIME);
      const result = await readActiveSubagents(dir, NOW);
      expect(result).toEqual([{}]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sorts most-recently-active first", async () => {
    const dir = await makeSubagentsDir();
    try {
      await writeAgent(dir, "older", NOW - 60_000, { agentType: "older" });
      await writeAgent(dir, "newer", NOW - 5_000, { agentType: "newer" });
      const result = await readActiveSubagents(dir, NOW);
      expect(result.map((s) => s.agentType)).toEqual(["newer", "older"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores non-agent files in the directory", async () => {
    const dir = await makeSubagentsDir();
    try {
      await writeAgent(dir, "real", ACTIVE_MTIME, { agentType: "Explore" });
      const stray = join(dir, "notes.txt");
      await writeFile(stray, "ignore me");
      await utimes(stray, ACTIVE_MTIME / 1000, ACTIVE_MTIME / 1000);
      const result = await readActiveSubagents(dir, NOW);
      expect(result).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
