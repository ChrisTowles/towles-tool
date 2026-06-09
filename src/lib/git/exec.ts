export interface XResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface XOptions {
  throwOnError?: boolean;
  cwd?: string;
}

export async function run(cmd: string, args: string[] = [], options?: XOptions): Promise<XResult> {
  const cwd = options?.cwd ?? process.cwd();
  const proc = Bun.spawn([cmd, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (options?.throwOnError && exitCode !== 0) {
    throw new Error(`Command failed (exit ${exitCode}): ${cmd} ${args.join(" ")}\n${stderr}`);
  }
  return { stdout, stderr, exitCode };
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
