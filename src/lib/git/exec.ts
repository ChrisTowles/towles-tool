import { spawn } from "node:child_process";

export interface XResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface XOptions {
  throwOnError?: boolean;
  cwd?: string;
}

// node:child_process instead of Bun.spawn so this also works under vitest's
// node workers, not just the bun runtime.
export async function run(cmd: string, args: string[] = [], options?: XOptions): Promise<XResult> {
  const cwd = options?.cwd ?? process.cwd();
  return await new Promise<XResult>((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      const exitCode = code ?? -1;
      if (options?.throwOnError && exitCode !== 0) {
        reject(new Error(`Command failed (exit ${exitCode}): ${cmd} ${args.join(" ")}\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });
  });
}

export async function exec(cmd: string, args: string[]): Promise<string> {
  const result = await run(cmd, args, { throwOnError: true });
  return result.stdout.trim();
}

export async function execSafe(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; ok: boolean }> {
  const result = await run(cmd, args);
  return { stdout: result.stdout.trim(), ok: result.exitCode === 0 };
}

export async function git(args: string[]): Promise<string> {
  return exec("git", args);
}
