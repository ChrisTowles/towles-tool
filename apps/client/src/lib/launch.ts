import { invoke } from "@/lib/tauri";
import { shellQuote } from "@/lib/agentboard/pty";

/** One dev-server config from a checkout's Claude Desktop
 * `.claude/launch.json` (`configurations[]`: name / runtimeExecutable /
 * runtimeArgs / port), with live status stamped by the backend — see
 * `launch_configs` in `crates-tauri/tt-app/src/launch.rs`. */
export type LaunchConfigStatus = {
  name: string;
  runtimeExecutable: string;
  runtimeArgs: string[];
  port?: number | null;
  portListening: boolean;
  sessionId?: string | null;
};

/** A folder's launch.json configs + live status. `Err` carries a message
 * worth showing (e.g. a malformed launch.json); a folder without the file
 * resolves `Ok([])`. */
export const launchConfigs = (dir: string) =>
  invoke<LaunchConfigStatus[]>("launch_configs", { dir });

export const launchRegister = (
  dir: string,
  name: string,
  sessionId: string,
  port: number | null,
  command: string,
) => invoke<void>("launch_register", { dir, name, sessionId, port, command });

const SAFE_TOKEN = /^[\w@%+=:,./-]+$/;

function quoteToken(token: string): string {
  return SAFE_TOKEN.test(token) ? token : shellQuote(token);
}

export function launchCommand(
  cfg: Pick<LaunchConfigStatus, "runtimeExecutable" | "runtimeArgs">,
): string {
  return [cfg.runtimeExecutable, ...cfg.runtimeArgs].map(quoteToken).join(" ");
}

export function devServerUrl(port: number): string {
  return `http://localhost:${port}/`;
}

export type LaunchAction = "focus" | "external" | "launch";

export function launchAction(cfg: LaunchConfigStatus): LaunchAction {
  // Our own pane wins: even with the port also listening, the pane is the
  // thing the user can actually look at and act in.
  if (cfg.sessionId) return "focus";
  // Port held by something we didn't launch — offering a second launch
  // would just crash into EADDRINUSE.
  if (cfg.portListening) return "external";
  return "launch";
}
