import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export type SpawnClaudeFn = (args: string[]) => ChildProcess;

/**
 * Spawns the Claude CLI as a child process.
 * Extracted into its own module so tests can mock it cleanly
 * without affecting other exec/spawn usage.
 */
export function spawnClaude(args: string[]): ChildProcess {
  return spawn("claude", args, {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "inherit"],
  });
}
