import { spawn } from "zigpty";
import { platform } from "node:os";
import { logger } from "~~/server/utils/logger";

function systemOpen(): string {
  return platform() === "darwin" ? "open" : "xdg-open";
}

/** Spawn a fire-and-forget command via PTY */
function fireAndForget(cmd: string, args: string[]) {
  const pty = spawn(cmd, args, { cols: 80, rows: 24 });
  pty.onExit(() => {
    pty.close();
  });
}

/**
 * Opens a URL in the system default browser.
 * Works on Linux (xdg-open) and macOS (open).
 */
export function openUrl(url: string) {
  logger.info(`Opening URL: ${url}`);
  fireAndForget(systemOpen(), [url]);
}

/**
 * Opens a directory or file in VS Code.
 */
export function openInVscode(path: string) {
  logger.info(`Opening in VS Code: ${path}`);
  fireAndForget("code", [path]);
}

/**
 * Opens a file with the system default application.
 */
export function openFile(path: string) {
  logger.info(`Opening file: ${path}`);
  fireAndForget(systemOpen(), [path]);
}
