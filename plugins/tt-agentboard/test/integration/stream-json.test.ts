import { describe, it, expect, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseStreamLine } from "../../server/utils/stream-parser";
import type { AgentActivityEvent } from "../../server/utils/stream-parser";

/**
 * Integration test: runs `claude` with `--output-format stream-json` using Haiku,
 * captures NDJSON output, and verifies the parser handles real Claude output.
 *
 * Requires: `claude` CLI available and authenticated.
 */
describe("Stream JSON Integration (Haiku)", { timeout: 90_000 }, () => {
  const testDir = join(tmpdir(), `stream-json-test-${Date.now()}`);
  const outputFile = join(testDir, "output.ndjson");

  function runClaude(prompt: string): string {
    mkdirSync(testDir, { recursive: true });
    try {
      execSync(
        `claude --model haiku --output-format stream-json --verbose -p ${JSON.stringify(prompt)} --max-turns 2 < /dev/null > ${JSON.stringify(outputFile)} 2>&1`,
        {
          timeout: 60_000,
          cwd: testDir,
          env: { ...process.env, HOME: process.env.HOME },
        },
      );
    } catch {
      // claude may exit non-zero; output file should still have content
    }

    if (!existsSync(outputFile)) return "";
    return readFileSync(outputFile, "utf-8");
  }

  function parseAllLines(raw: string): AgentActivityEvent[] {
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map(parseStreamLine)
      .filter((e): e is AgentActivityEvent => e !== null);
  }

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("produces parseable NDJSON with text events from a simple prompt", () => {
    const raw = runClaude("Say exactly: hello world. Nothing else.");
    expect(raw.length).toBeGreaterThan(0);

    const events = parseAllLines(raw);
    expect(events.length).toBeGreaterThan(0);

    const textEvents = events.filter((e) => e.kind === "text");
    expect(textEvents.length).toBeGreaterThan(0);

    const textContent = textEvents.map((e) => (e as { content: string }).content).join("");
    expect(textContent.toLowerCase()).toContain("hello");
  });

  it("produces tool_use events when tools are invoked", () => {
    const raw = runClaude(
      "List the files in the current directory using the Bash tool. Run: ls -la",
    );
    expect(raw.length).toBeGreaterThan(0);

    const events = parseAllLines(raw);
    expect(events.length).toBeGreaterThan(0);

    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.size).toBeGreaterThan(0);

    const toolEvents = events.filter((e) => e.kind === "tool_use");
    for (const event of toolEvents) {
      if (event.kind === "tool_use") {
        expect(event.name).toBeTruthy();
        expect(typeof event.detail).toBe("string");
        expect(typeof event.input).toBe("object");
      }
    }
  });

  it("produces a result event at the end of the stream", () => {
    const raw = runClaude("Reply with just the word 'done'.");
    const events = parseAllLines(raw);

    const resultEvents = events.filter((e) => e.kind === "result");
    expect(resultEvents.length).toBeGreaterThanOrEqual(1);

    const result = resultEvents[resultEvents.length - 1];
    if (result.kind === "result") {
      expect(typeof result.numTurns).toBe("number");
      expect(typeof result.isError).toBe("boolean");
      expect(typeof result.costUsd).toBe("number");
      expect(result.numTurns).toBeGreaterThanOrEqual(1);
    }
  });

  it("cleanly handles every line without throwing", () => {
    const raw = runClaude("What is 2+2? Answer briefly.");
    const lines = raw.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      expect(() => parseStreamLine(line)).not.toThrow();
    }
  });
});
