import { existsSync, mkdirSync } from "node:fs";
import consola from "consola";
import { colors } from "consola/utils";

/**
 * Create journal directory if it doesn't exist
 */
export function ensureDirectoryExists(folderPath: string): void {
  if (!existsSync(folderPath)) {
    consola.info(`Creating journal directory: ${colors.cyan(folderPath)}`);
    mkdirSync(folderPath, { recursive: true });
  }
}
