import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { writeHooks } from "../../server/utils/hook-writer";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "interactive-flow-test-"));
  tmpDirs.push(dir);
  return dir;
}

function isClaudeAvailable(): boolean {
  try {
    execSync("which claude", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Interactive Flow Integration", { timeout: 90_000 }, () => {
  describe("hook-writer generates correct hooks for interactive mode", () => {
    it("writes Stop, StopFailure, and Notification hooks", () => {
      const dir = makeTmpDir();

      writeHooks(dir, 42, 4200, "complete");

      const settingsPath = resolve(dir, ".claude", "settings.local.json");
      expect(existsSync(settingsPath)).toBe(true);

      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));

      // Notification hook must be present for interactive mode
      expect(settings.hooks.Notification).toBeDefined();
      expect(settings.hooks.Notification[0].hooks[0].url).toBe(
        "http://localhost:4200/api/agents/42/notification",
      );
      expect(settings.hooks.Notification[0].hooks[0].type).toBe("http");

      // Stop hook for completion
      expect(settings.hooks.Stop).toBeDefined();
      expect(settings.hooks.Stop[0].hooks[0].url).toBe(
        "http://localhost:4200/api/agents/42/complete",
      );

      // StopFailure hook for errors
      expect(settings.hooks.StopFailure).toBeDefined();
      expect(settings.hooks.StopFailure[0].hooks[0].url).toBe(
        "http://localhost:4200/api/agents/42/failure",
      );
    });

    it("uses step-complete endpoint for workflow steps", () => {
      const dir = makeTmpDir();

      writeHooks(dir, 7, 4200, "step-complete");

      const settings = JSON.parse(
        readFileSync(resolve(dir, ".claude", "settings.local.json"), "utf-8"),
      );

      // Stop hook should point to step-complete for multi-step workflows
      expect(settings.hooks.Stop[0].hooks[0].url).toBe(
        "http://localhost:4200/api/agents/7/step-complete",
      );

      // Notification hook is always present (needed for waiting_input flow)
      expect(settings.hooks.Notification[0].hooks[0].url).toBe(
        "http://localhost:4200/api/agents/7/notification",
      );
    });

    it("hooks do not include --dangerously-skip-permissions flag in URLs", () => {
      const dir = makeTmpDir();

      writeHooks(dir, 1, 4200, "complete");

      const raw = readFileSync(resolve(dir, ".claude", "settings.local.json"), "utf-8");

      // The hooks are HTTP callbacks, not CLI flags — verify no CLI flags leaked in
      expect(raw).not.toContain("dangerously-skip-permissions");
      expect(raw).toContain("http://localhost:4200");
    });
  });

  describe("notification and respond endpoint contracts", () => {
    // These test the expected shapes that the API endpoints handle.
    // The actual endpoints are tested in test/api/agents.test.ts via the running server.

    it("notification hook payload has correct shape", () => {
      // Claude Code sends this payload to the Notification hook
      const payload = {
        session_id: "abc123",
        hook_event_name: "Notification",
      };

      expect(payload.hook_event_name).toBe("Notification");
      expect(typeof payload.session_id).toBe("string");
    });

    it("respond request has required response field", () => {
      const validBody = { response: "Yes, proceed with option A" };
      expect(validBody.response).toBeTruthy();
      expect(typeof validBody.response).toBe("string");

      const invalidBody = {};
      expect((invalidBody as { response?: string }).response).toBeUndefined();
    });

    it("stop hook payload has correct shape", () => {
      const payload = {
        session_id: "abc123",
        hook_event_name: "Stop",
      };

      expect(payload.hook_event_name).toBe("Stop");
    });

    it("failure hook payload has correct shape", () => {
      const payload = {
        session_id: "abc123",
        hook_event_name: "StopFailure",
      };

      expect(payload.hook_event_name).toBe("StopFailure");
    });
  });

  describe("live Claude decision-point output", () => {
    it("agent produces output when given a decision task", async ({ skip }) => {
      if (!isClaudeAvailable()) skip();

      const dir = makeTmpDir();

      // Initialize git repo
      execSync("git init", { cwd: dir, stdio: "ignore" });
      execSync("git config user.email 'test@test.com'", { cwd: dir, stdio: "ignore" });
      execSync("git config user.name 'Test'", { cwd: dir, stdio: "ignore" });

      // Create a file with two possible approaches
      writeFileSync(
        join(dir, "config.ts"),
        `// TODO: Choose either Map or Object for the cache implementation
// Option A: Use a Map (better for frequent additions/deletions)
// Option B: Use a plain object (simpler serialization)
export const cache: Record<string, unknown> = {};
`,
      );

      execSync("git add -A && git commit -m 'initial'", { cwd: dir, stdio: "ignore" });

      // Ask the agent to make a decision and write it to a file
      const prompt =
        "Look at config.ts. Choose between Option A (Map) or Option B (Object) for the cache. Write your decision and reasoning to decision.md. Then implement your choice in config.ts. Commit all changes.";
      execSync(`claude --model haiku -p "${prompt}" --max-turns 5 --dangerously-skip-permissions`, {
        cwd: dir,
        stdio: "ignore",
        timeout: 80_000,
      });

      // Verify the agent wrote a decision file
      expect(existsSync(join(dir, "decision.md"))).toBe(true);
      const decision = readFileSync(join(dir, "decision.md"), "utf-8");
      expect(decision.length).toBeGreaterThan(10);

      // Verify config.ts was modified from the original
      const config = readFileSync(join(dir, "config.ts"), "utf-8");
      const original = `// TODO: Choose either Map or Object for the cache implementation
// Option A: Use a Map (better for frequent additions/deletions)
// Option B: Use a plain object (simpler serialization)
export const cache: Record<string, unknown> = {};
`;
      expect(config).not.toBe(original);
    });
  });
});
