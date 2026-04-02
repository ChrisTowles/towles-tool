import { exec } from "node:child_process";
import { promisify } from "node:util";
import consola from "consola";

const execAsync = promisify(exec);

/**
 * Open file in default editor with folder context
 */
export async function openInEditor({
  editor,
  filePath,
  folderPath,
}: {
  editor: string;
  filePath: string;
  folderPath?: string;
}): Promise<void> {
  try {
    if (folderPath) {
      // Open both folder and file - this works with VS Code and similar editors
      // the purpose is to open the folder context for better navigation
      await execAsync(`"${editor}" "${folderPath}" "${filePath}"`);
    } else {
      await execAsync(`"${editor}" "${filePath}"`);
    }
  } catch (ex) {
    consola.warn(
      `Could not open in editor : '${editor}'. Modify your editor in the config: examples include 'code', 'code-insiders',  etc...`,
      ex,
    );
  }
}
