import { exec, execSafe, run as defaultX } from "./exec.js";
import type { XResult } from "./exec.js";

export type XFn = (
  cmd: string,
  args?: string[],
  opts?: Record<string, unknown>,
) => PromiseLike<XResult>;

export async function isGithubCliInstalled(execFn: XFn = defaultX): Promise<boolean> {
  try {
    const proc = await execFn("gh", ["--version"]);
    return proc.stdout.includes("https://github.com/cli/cli");
  } catch {
    return false;
  }
}

export async function gh<T = unknown>(args: string[]): Promise<T> {
  const stdout = await exec("gh", args);
  return JSON.parse(stdout) as T;
}

export async function ghRaw(
  args: string[],
  execFn?: (cmd: string, args: string[]) => Promise<{ stdout: string; ok: boolean }>,
): Promise<string> {
  const fn = execFn ?? execSafe;
  const result = await fn("gh", args);
  return result.stdout;
}

export interface Issue {
  labels: {
    name: string;
    color: string;
  }[];
  number: number;
  title: string;
  state: string;
}

export async function getIssues({
  assignedToMe,
  cwd,
  label,
  exec: execFn = defaultX,
}: {
  assignedToMe?: boolean;
  cwd: string;
  exec?: XFn;
  label?: string;
}): Promise<Issue[]> {
  const args = ["issue", "list", "--json", "labels,number,title,state"];

  if (assignedToMe) {
    args.push("--assignee", "@me");
  }

  if (label) {
    args.push("--label", label);
  }

  const result = await execFn("gh", args);
  const stripped = Bun.stripANSI(result.stdout);

  try {
    return JSON.parse(stripped) as Issue[];
  } catch {
    throw new Error(
      `Failed to parse GitHub CLI output as JSON. Raw output: ${stripped.slice(0, 200)}${stripped.length > 200 ? "..." : ""}`,
    );
  }
}
