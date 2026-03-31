import { spawn } from "zigpty";

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;?]*[a-zA-Z]|\x1B[><=][0-9]*[a-zA-Z]?|\x1B\][^\x07]*\x07?|\r/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export interface PtyExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
}

export interface PtyExecResult {
  stdout: string;
  exitCode: number;
}

export class PtyExecError extends Error {
  constructor(
    public readonly command: string,
    public readonly exitCode: number,
    public readonly stdout: string,
  ) {
    super(`Command failed (exit ${exitCode}): ${command}\n${stdout}`);
    this.name = "PtyExecError";
  }
}

/**
 * Spawn a command in a real PTY, collect output, and return when done.
 * Throws PtyExecError on non-zero exit.
 */
export async function ptyExec(
  command: string,
  args: string[] = [],
  opts: PtyExecOptions = {},
): Promise<PtyExecResult> {
  const pty = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env as Record<string, string> | undefined,
    cols: 200,
    rows: 24,
  });

  let output = "";
  pty.onData((data) => {
    output += typeof data === "string" ? data : data.toString();
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const exitCode = await (opts.timeout
    ? Promise.race([
        pty.exited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            pty.kill();
            reject(new PtyExecError(`${command} ${args.join(" ")}`, -1, stripAnsi(output)));
          }, opts.timeout);
        }),
      ]).finally(() => clearTimeout(timer))
    : pty.exited);

  const stdout = stripAnsi(output).trim();

  if (exitCode !== 0) {
    throw new PtyExecError(`${command} ${args.join(" ")}`, exitCode, stdout);
  }

  return { stdout, exitCode };
}

/**
 * Run a shell command string in a PTY (via sh -c).
 */
export async function ptyExecShell(
  shellCommand: string,
  opts: PtyExecOptions = {},
): Promise<PtyExecResult> {
  return ptyExec("sh", ["-c", shellCommand], opts);
}

export type PtyExecFn = typeof ptyExec;
export type PtyExecShellFn = typeof ptyExecShell;
