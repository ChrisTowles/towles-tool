import { existsSync } from "node:fs";
import consola from "consola";
import { colors } from "consola/utils";
import { ensureDir } from "../../utils/fs.js";

/**
 * Create journal directory if it doesn't exist
 */
export function ensureDirectoryExists(folderPath: string): void {
  if (!existsSync(folderPath)) {
    consola.info(`Creating journal directory: ${colors.cyan(folderPath)}`);
    ensureDir(folderPath);
  }
}
