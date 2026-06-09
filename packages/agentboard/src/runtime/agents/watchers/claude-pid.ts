import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudePidLookup {
  pidForThread(threadId: string): Promise<number | null>;
  isAlive(pid: number): boolean;
  invalidate(): void;
}

const DEFAULT_SESSIONS_DIR = join(homedir(), ".claude", "sessions");

export function createClaudePidLookup(sessionsDir: string = DEFAULT_SESSIONS_DIR): ClaudePidLookup {
  let cache: Map<string, number> | null = null;

  async function loadCache(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    let files: string[];
    try {
      files = await readdir(sessionsDir);
    } catch {
      return map;
    }

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const text = await readFile(join(sessionsDir, file), "utf-8");
        const data = JSON.parse(text) as { pid?: number; sessionId?: string };
        if (typeof data.pid === "number" && typeof data.sessionId === "string") {
          map.set(data.sessionId, data.pid);
        }
      } catch {
        // skip unreadable / invalid JSON
      }
    }
    return map;
  }

  return {
    async pidForThread(threadId) {
      if (!cache) cache = await loadCache();
      return cache.get(threadId) ?? null;
    },
    isAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    invalidate() {
      cache = null;
    },
  };
}
