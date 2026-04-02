export interface XResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface XOptions {
  throwOnError?: boolean;
  nodeOptions?: { cwd?: string };
}

/**
 * Run a command and return stdout, stderr, and exitCode.
 * Drop-in replacement for tinyexec's `x()`.
 */
export async function run(cmd: string, args: string[] = [], options?: XOptions): Promise<XResult> {
  const cwd = options?.nodeOptions?.cwd ?? process.cwd();
  const proc = Bun.spawn([cmd, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (options?.throwOnError && exitCode !== 0) {
    throw new Error(`Command failed (exit ${exitCode}): ${cmd} ${args.join(" ")}\n${stderr}`);
  }
  return { stdout, stderr, exitCode };
}

export async function exec(cmd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([cmd, ...args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Command failed: ${cmd} ${args.join(" ")}\n${stderr}`);
  }
  return stdout.trim();
}

export async function execSafe(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; ok: boolean }> {
  const proc = Bun.spawn([cmd, ...args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  return { stdout: stdout.trim(), ok: exitCode === 0 };
}

export async function git(args: string[]): Promise<string> {
  return exec("git", args);
}
