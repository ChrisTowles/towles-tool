import { execSync } from "node:child_process";
import { platform } from "node:os";
import { logger } from "~~/server/utils/logger";

/**
 * Opens a URL in the system default browser.
 * Works on Linux (xdg-open) and macOS (open).
 */
export function openUrl(url: string) {
  const cmd = platform() === "darwin" ? "open" : "xdg-open";
  logger.info(`Opening URL: ${url}`);
  execSync(`${cmd} ${JSON.stringify(url)}`, { stdio: "ignore" });
}

/**
 * Opens a directory or file in VS Code.
 */
export function openInVscode(path: string) {
  logger.info(`Opening in VS Code: ${path}`);
  execSync(`code ${JSON.stringify(path)}`, { stdio: "ignore" });
}

/**
 * Opens a file with the system default application.
 */
export function openFile(path: string) {
  const cmd = platform() === "darwin" ? "open" : "xdg-open";
  logger.info(`Opening file: ${path}`);
  execSync(`${cmd} ${JSON.stringify(path)}`, { stdio: "ignore" });
}
