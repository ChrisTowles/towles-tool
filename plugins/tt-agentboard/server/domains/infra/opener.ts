import { execFileSync } from "node:child_process";
import { platform } from "node:os";
import { logger } from "~~/server/utils/logger";

function systemOpen(): string {
  return platform() === "darwin" ? "open" : "xdg-open";
}

/**
 * Opens a URL in the system default browser.
 * Works on Linux (xdg-open) and macOS (open).
 */
export function openUrl(url: string) {
  logger.info(`Opening URL: ${url}`);
  execFileSync(systemOpen(), [url], { stdio: "ignore" });
}

/**
 * Opens a directory or file in VS Code.
 */
export function openInVscode(path: string) {
  logger.info(`Opening in VS Code: ${path}`);
  execFileSync("code", [path], { stdio: "ignore" });
}

/**
 * Opens a file with the system default application.
 */
export function openFile(path: string) {
  logger.info(`Opening file: ${path}`);
  execFileSync(systemOpen(), [path], { stdio: "ignore" });
}
