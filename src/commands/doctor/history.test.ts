import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadHistory, saveHistory, diffRuns } from "./history.js";
import type { DoctorRunResult } from "./checks.js";

function makeResult(overrides: Partial<DoctorRunResult> = {}): DoctorRunResult {
  return {
    timestamp: new Date().toISOString(),
    tools: [
      { name: "git", version: "2.40.0", ok: true },
      { name: "node", version: "20.11.0", ok: true },
      { name: "bun", version: "1.1.0", ok: true },
    ],
    ghAuth: true,
    plugins: [{ name: "code-simplifier", ok: true }],
    agentboard: [{ name: "database", ok: true }],
    ...overrides,
  };
}

describe("loadHistory / saveHistory", () => {
  let tmpDir: string;
  let historyPath: string;

  beforeEach(() => {
    tmpDir = resolve(tmpdir(), `doctor-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    historyPath = resolve(tmpDir, "doctor-history.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when no file exists", () => {
    expect(loadHistory(historyPath)).toEqual([]);
  });

  it("saves and loads a run", () => {
    const result = makeResult();
    saveHistory(result, historyPath);

    const history = loadHistory(historyPath);
    expect(history).toHaveLength(1);
    expect(history[0].timestamp).toBe(result.timestamp);
    expect(history[0].tools).toEqual(result.tools);
  });

  it("appends multiple runs", () => {
    saveHistory(makeResult({ timestamp: "2024-01-01T00:00:00Z" }), historyPath);
    saveHistory(makeResult({ timestamp: "2024-01-02T00:00:00Z" }), historyPath);

    const history = loadHistory(historyPath);
    expect(history).toHaveLength(2);
    expect(history[0].timestamp).toBe("2024-01-01T00:00:00Z");
    expect(history[1].timestamp).toBe("2024-01-02T00:00:00Z");
  });

  it("caps history at 50 entries", () => {
    for (let i = 0; i < 55; i++) {
      saveHistory(
        makeResult({ timestamp: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00Z` }),
        historyPath,
      );
    }

    const history = loadHistory(historyPath);
    expect(history).toHaveLength(50);
    expect(history[0].timestamp).toBe("2024-01-06T00:00:00Z");
  });

  it("handles corrupted JSON gracefully", () => {
    writeFileSync(historyPath, "not json", "utf-8");
    expect(loadHistory(historyPath)).toEqual([]);
  });
});

describe("diffRuns", () => {
  it("detects version upgrades", () => {
    const prev = makeResult({ tools: [{ name: "bun", version: "1.0.0", ok: true }] });
    const curr = makeResult({ tools: [{ name: "bun", version: "1.1.0", ok: true }] });

    const diffs = diffRuns(prev, curr);
    const bunDiff = diffs.find((d) => d.name === "bun" && d.change === "upgraded");
    expect(bunDiff).toBeDefined();
    expect(bunDiff!.oldValue).toBe("1.0.0");
    expect(bunDiff!.newValue).toBe("1.1.0");
  });

  it("detects version downgrades", () => {
    const prev = makeResult({ tools: [{ name: "node", version: "22.0.0", ok: true }] });
    const curr = makeResult({ tools: [{ name: "node", version: "20.11.0", ok: true }] });

    const diffs = diffRuns(prev, curr);
    const nodeDiff = diffs.find((d) => d.name === "node" && d.change === "downgraded");
    expect(nodeDiff).toBeDefined();
  });

  it("detects new tools", () => {
    const prev = makeResult({ tools: [] });
    const curr = makeResult({ tools: [{ name: "git", version: "2.40.0", ok: true }] });

    const diffs = diffRuns(prev, curr);
    expect(diffs).toContainEqual(
      expect.objectContaining({ name: "git", change: "added", newValue: "2.40.0" }),
    );
  });

  it("detects removed tools", () => {
    const prev = makeResult({ tools: [{ name: "ttyd", version: "1.7.0", ok: true }] });
    const curr = makeResult({ tools: [] });

    const diffs = diffRuns(prev, curr);
    expect(diffs).toContainEqual(
      expect.objectContaining({ name: "ttyd", change: "removed", oldValue: "1.7.0" }),
    );
  });

  it("detects check status flips", () => {
    const prev = makeResult({ tools: [{ name: "bun", version: "1.1.0", ok: true }] });
    const curr = makeResult({ tools: [{ name: "bun", version: "1.1.0", ok: false }] });

    const diffs = diffRuns(prev, curr);
    expect(diffs).toContainEqual(expect.objectContaining({ name: "bun", change: "failed" }));
  });

  it("detects gh auth changes", () => {
    const prev = makeResult({ ghAuth: true });
    const curr = makeResult({ ghAuth: false });

    const diffs = diffRuns(prev, curr);
    expect(diffs).toContainEqual(expect.objectContaining({ name: "gh auth", change: "failed" }));
  });

  it("detects plugin status changes", () => {
    const prev = makeResult({ plugins: [{ name: "code-simplifier", ok: false }] });
    const curr = makeResult({ plugins: [{ name: "code-simplifier", ok: true }] });

    const diffs = diffRuns(prev, curr);
    expect(diffs).toContainEqual(
      expect.objectContaining({ category: "plugin", name: "code-simplifier", change: "passed" }),
    );
  });

  it("detects agentboard status changes", () => {
    const prev = makeResult({ agentboard: [{ name: "database", ok: false }] });
    const curr = makeResult({ agentboard: [{ name: "database", ok: true }] });

    const diffs = diffRuns(prev, curr);
    expect(diffs).toContainEqual(
      expect.objectContaining({ category: "agentboard", name: "database", change: "passed" }),
    );
  });

  it("returns empty array when nothing changed", () => {
    const run = makeResult();
    expect(diffRuns(run, run)).toEqual([]);
  });
});
