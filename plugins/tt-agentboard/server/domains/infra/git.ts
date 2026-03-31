import { ptyExec } from "./pty-exec";

/** Run a git command. Returns stdout. Throws on error. */
export async function gitRun(cwd: string, args: string[]): Promise<string> {
  const result = await ptyExec("git", args, { cwd });
  return result.stdout.trim();
}

/** Run a git command. Returns stdout or null on error. */
export async function gitQuery(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await gitRun(cwd, args);
  } catch {
    return null;
  }
}
