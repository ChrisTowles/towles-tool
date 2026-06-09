import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudePidLookup } from "./claude-pid";

let tmpDir: string;
let sessionsDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-pid-test-"));
  sessionsDir = join(tmpDir, "sessions");
  mkdirSync(sessionsDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeSession(pid: number, sessionId: string) {
  writeFileSync(
    join(sessionsDir, `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd: "/tmp", startedAt: Date.now(), kind: "interactive" }),
  );
}

describe("claude-pid lookup", () => {
  it("finds PID by threadId", async () => {
    writeSession(12345, "thread-a");
    writeSession(67890, "thread-b");
    const lookup = createClaudePidLookup(sessionsDir);
    expect(await lookup.pidForThread("thread-a")).toBe(12345);
    expect(await lookup.pidForThread("thread-b")).toBe(67890);
  });

  it("returns null for unknown threadId", async () => {
    writeSession(12345, "thread-a");
    const lookup = createClaudePidLookup(sessionsDir);
    expect(await lookup.pidForThread("thread-missing")).toBeNull();
  });

  it("returns null when sessions dir is missing", async () => {
    const lookup = createClaudePidLookup(join(tmpDir, "does-not-exist"));
    expect(await lookup.pidForThread("thread-a")).toBeNull();
  });

  it("skips invalid session JSON files", async () => {
    writeFileSync(join(sessionsDir, "bad.json"), "not json");
    writeSession(12345, "thread-a");
    const lookup = createClaudePidLookup(sessionsDir);
    expect(await lookup.pidForThread("thread-a")).toBe(12345);
  });

  it("isAlive returns true for current process pid", () => {
    const lookup = createClaudePidLookup(sessionsDir);
    expect(lookup.isAlive(process.pid)).toBe(true);
  });

  it("isAlive returns false for pid 999999999", () => {
    const lookup = createClaudePidLookup(sessionsDir);
    expect(lookup.isAlive(999_999_999)).toBe(false);
  });

  it("invalidate clears the cache so new sessions are picked up", async () => {
    const lookup = createClaudePidLookup(sessionsDir);
    // Prime cache with empty result
    expect(await lookup.pidForThread("thread-a")).toBeNull();
    writeSession(12345, "thread-a");
    // Still null because cache is stale
    expect(await lookup.pidForThread("thread-a")).toBeNull();
    lookup.invalidate();
    expect(await lookup.pidForThread("thread-a")).toBe(12345);
  });
});
