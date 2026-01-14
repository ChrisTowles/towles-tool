import { execSync } from "node:child_process";

// TODO change to use tinyexec or similar for better error handling
export function execCommand(cmd: string, cwd?: string) {
  // Note about execSync, if the command fails or times out, it might not throw an error,
  // if the child process intercepts the SIGTERM signal, we might not get an error.
  return execSync(cmd, { encoding: "utf8", cwd }).trim();
}
