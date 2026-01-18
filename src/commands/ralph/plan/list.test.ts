/**
 * Integration tests for oclif ralph plan list command
 * Note: --help output goes through oclif's own routing
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runCommand } from "@oclif/test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";

describe("ralph plan list command", () => {
  const tempStateFile = join(tmpdir(), `ralph-test-list-${Date.now()}.json`);

  beforeAll(() => {
    // Create state file with one plan to minimize output during tests
    writeFileSync(
      tempStateFile,
      JSON.stringify({
        version: 1,
        iteration: 0,
        maxIterations: 10,
        status: "running",
        plans: [{ id: 1, description: "test", status: "done", addedAt: new Date().toISOString() }],
        startedAt: new Date().toISOString(),
      }),
    );
  });

  afterAll(() => {
    if (existsSync(tempStateFile)) unlinkSync(tempStateFile);
  });

  it("runs plan list without error", async () => {
    const { error } = await runCommand(["ralph:plan:list", "-s", tempStateFile]);
    expect(error).toBeUndefined();
  });

  it("supports --format flag", async () => {
    const { error } = await runCommand([
      "ralph:plan:list",
      "--format",
      "markdown",
      "-s",
      tempStateFile,
    ]);
    expect(error).toBeUndefined();
  });
});
