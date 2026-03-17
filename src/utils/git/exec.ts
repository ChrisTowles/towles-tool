import { x } from "tinyexec";

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

export async function git(args: string[]): Promise<string> {
  return exec("git", args);
}
