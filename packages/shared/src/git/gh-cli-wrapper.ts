import stripAnsi from "strip-ansi";

import { exec, execSafe } from "./exec.js";

export interface ExecOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type XFn = (
  cmd: string,
  args?: string[],
  opts?: Record<string, unknown>,
) => PromiseLike<ExecOutput>;

async function defaultX(cmd: string, args: string[] = []): Promise<ExecOutput> {
  const proc = Bun.spawn([cmd, ...args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode };
}

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
  const stripped = stripAnsi(result.stdout);

  try {
    return JSON.parse(stripped) as Issue[];
  } catch {
    throw new Error(
      `Failed to parse GitHub CLI output as JSON. Raw output: ${stripped.slice(0, 200)}${stripped.length > 200 ? "..." : ""}`,
    );
  }
}
