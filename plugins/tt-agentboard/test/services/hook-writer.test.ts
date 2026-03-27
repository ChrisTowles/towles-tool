import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { writeHooks } from "../../server/domains/infra/hook-writer";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hook-writer-"));
  tmpDirs.push(dir);
  return dir;
}

function readSettings(slotPath: string): Record<string, unknown> {
  const settingsPath = resolve(slotPath, ".claude", "settings.local.json");
  return JSON.parse(readFileSync(settingsPath, "utf-8"));
}

afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("writeHooks()", () => {
  it("creates .claude dir if missing", () => {
    const slotPath = makeTmpDir();

    writeHooks(slotPath, 42, 4200, "complete");

    expect(existsSync(resolve(slotPath, ".claude"))).toBe(true);
    expect(existsSync(resolve(slotPath, ".claude", "settings.local.json"))).toBe(true);
  });

  it("writes correct Stop, StopFailure, Notification hooks", () => {
    const slotPath = makeTmpDir();

    writeHooks(slotPath, 7, 4200, "step-complete");

    const settings = readSettings(slotPath) as {
      hooks: Record<
        string,
        Array<{ matcher: string; hooks: Array<{ type: string; url: string }> }>
      >;
    };

    expect(settings.hooks.Stop[0]!.hooks[0]!.url).toBe(
      "http://localhost:4200/api/agents/7/step-complete",
    );
    expect(settings.hooks.StopFailure[0]!.hooks[0]!.url).toBe(
      "http://localhost:4200/api/agents/7/failure",
    );
    expect(settings.hooks.Notification[0]!.hooks[0]!.url).toBe(
      "http://localhost:4200/api/agents/7/notification",
    );

    // All hooks should use http type and empty matcher
    for (const hookName of ["Stop", "StopFailure", "Notification"]) {
      const hookArray = settings.hooks[hookName]!;
      expect(hookArray).toHaveLength(1);
      expect(hookArray[0]!.matcher).toBe("");
      expect(hookArray[0]!.hooks[0]!.type).toBe("http");
    }
  });

  it("merges with existing settings.local.json", () => {
    const slotPath = makeTmpDir();
    const claudeDir = resolve(slotPath, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    // Write existing settings with other keys
    writeFileSync(
      resolve(claudeDir, "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Bash"] }, customKey: "preserved" }, null, 2),
    );

    writeHooks(slotPath, 10, 4200, "complete");

    const settings = readSettings(slotPath) as Record<string, unknown>;
    expect(settings.permissions).toEqual({ allow: ["Bash"] });
    expect(settings.customKey).toBe("preserved");
    expect(settings.hooks).toBeDefined();
  });

  it("preserves existing hook entries from other sources", () => {
    const slotPath = makeTmpDir();
    const claudeDir = resolve(slotPath, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    // Write existing settings with existing hooks
    writeFileSync(
      resolve(claudeDir, "settings.local.json"),
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "lint" }] }],
          },
        },
        null,
        2,
      ),
    );

    writeHooks(slotPath, 5, 4200, "complete");

    const settings = readSettings(slotPath) as {
      hooks: Record<string, unknown[]>;
    };
    // PreToolUse should be preserved via spread
    expect(settings.hooks.PreToolUse).toBeDefined();
    // New hooks should be added
    expect(settings.hooks.Stop).toBeDefined();
  });

  it("handles corrupted existing settings file", () => {
    const slotPath = makeTmpDir();
    const claudeDir = resolve(slotPath, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    writeFileSync(resolve(claudeDir, "settings.local.json"), "not valid json{{{");

    // Should not throw, starts fresh
    expect(() => writeHooks(slotPath, 1, 4200, "complete")).not.toThrow();

    const settings = readSettings(slotPath) as { hooks: Record<string, unknown> };
    expect(settings.hooks.Stop).toBeDefined();
  });

  it("file ends with newline", () => {
    const slotPath = makeTmpDir();

    writeHooks(slotPath, 1, 4200, "complete");

    const raw = readFileSync(resolve(slotPath, ".claude", "settings.local.json"), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
  });
});
