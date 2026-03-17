import { x } from "tinyexec";

// ── Shell helpers ──

async function exec(cmd: string, args: string[]): Promise<string> {
  const result = await x(cmd, args, { nodeOptions: { cwd: process.cwd() }, throwOnError: true });
  return result.stdout.trim();
}

export async function execSafe(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; ok: boolean }> {
  const result = await x(cmd, args, { nodeOptions: { cwd: process.cwd() }, throwOnError: false });
  return { stdout: (result.stdout ?? "").trim(), ok: result.exitCode === 0 };
}

export async function gh<T = unknown>(args: string[]): Promise<T> {
  const out = await exec("gh", args);
  return JSON.parse(out) as T;
}

export async function ghRaw(args: string[]): Promise<string> {
  const result = await execSafe("gh", args);
  return result.stdout;
}

export async function git(args: string[]): Promise<string> {
  return exec("git", args);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
