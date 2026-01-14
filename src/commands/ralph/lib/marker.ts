import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import * as readline from "node:readline";

// ============================================================================
// Constants
// ============================================================================

export const MARKER_PREFIX = "RALPH_MARKER_";
const CLAUDE_DIR = path.join(homedir(), ".claude");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");

// ============================================================================
// Marker Generation
// ============================================================================

/**
 * Generate a random marker string (8 chars alphanumeric)
 */
export function generateMarker(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// ============================================================================
// Session Search
// ============================================================================

/**
 * Get the project directory path for the current working directory
 */
function getProjectDir(): string | null {
  const cwd = process.cwd();
  // Claude stores projects with path separators replaced by dashes
  const projectName = cwd.replace(/\//g, "-");
  const projectDir = path.join(PROJECTS_DIR, projectName);

  if (fs.existsSync(projectDir)) {
    return projectDir;
  }
  return null;
}

/**
 * Search for a marker in session files and return the session ID.
 * Expects the full marker (e.g., RALPH_MARKER_abc123).
 */
export async function findSessionByMarker(marker: string): Promise<string | null> {
  const projectDir = getProjectDir();
  if (!projectDir) {
    return null;
  }

  // Get all .jsonl files in the project directory
  const files = fs
    .readdirSync(projectDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({
      name: f,
      path: path.join(projectDir, f),
      mtime: fs.statSync(path.join(projectDir, f)).mtime.getTime(),
    }))
    // Sort by most recent first
    .sort((a, b) => b.mtime - a.mtime);

  for (const file of files) {
    const found = await searchFileForMarker(file.path, marker);
    if (found) {
      // Session ID is the filename without .jsonl
      return file.name.replace(".jsonl", "");
    }
  }

  return null;
}

/**
 * Search a single file for the marker (streaming to handle large files)
 */
async function searchFileForMarker(filePath: string, marker: string): Promise<boolean> {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let found = false;

    rl.on("line", (line) => {
      if (line.includes(marker)) {
        found = true;
        rl.close();
        stream.destroy();
      }
    });

    rl.on("close", () => {
      resolve(found);
    });

    rl.on("error", () => {
      resolve(false);
    });
  });
}
