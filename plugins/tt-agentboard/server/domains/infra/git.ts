import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Run a git command. Returns stdout. Throws on error. */
export async function gitRun(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

/** Run a git command. Returns stdout or null on error. */
export async function gitQuery(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await gitRun(cwd, args);
  } catch {
    return null;
  }
}
