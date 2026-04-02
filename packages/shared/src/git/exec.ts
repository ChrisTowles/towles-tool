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
