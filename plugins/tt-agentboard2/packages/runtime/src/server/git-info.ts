import { existsSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";
import type { SessionData } from "../shared";

// --- Shell helper (for git commands only) ---

export function shell(cmd: string[]): string {
  try {
    const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return result.stdout.toString().trim();
  } catch {
    return "";
  }
}

// --- Git helpers ---

export interface GitInfo {
  branch: string;
  dirty: boolean;
  isWorktree: boolean;
}

const gitInfoCache = new Map<string, { info: GitInfo; ts: number }>();
const GIT_CACHE_TTL_MS = 5000;

export function getGitInfo(dir: string): GitInfo {
  if (!dir) return { branch: "", dirty: false, isWorktree: false };

  const cached = gitInfoCache.get(dir);
  if (cached && Date.now() - cached.ts < GIT_CACHE_TTL_MS) return cached.info;

  const branch = shell(["git", "-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch) return { branch: "", dirty: false, isWorktree: false };
  const gitDir = shell(["git", "-C", dir, "rev-parse", "--git-dir"]);
  const statusOut = shell(["git", "-C", dir, "status", "--porcelain"]);
  const info: GitInfo = {
    branch,
    dirty: statusOut.length > 0,
    isWorktree: gitDir.includes("/worktrees/"),
  };
  gitInfoCache.set(dir, { info, ts: Date.now() });
  return info;
}

export function invalidateGitCache(dir?: string): void {
  if (dir) gitInfoCache.delete(dir);
  else gitInfoCache.clear();
}

// --- Git HEAD file watchers ---

const gitHeadWatchers = new Map<string, FSWatcher>();

function resolveGitHeadPath(dir: string): string | null {
  if (!dir) return null;
  const gitDir = shell(["git", "-C", dir, "rev-parse", "--git-dir"]);
  if (!gitDir) return null;
  const absGitDir = gitDir.startsWith("/") ? gitDir : join(dir, gitDir);
  const headPath = join(absGitDir, "HEAD");
  return existsSync(headPath) ? headPath : null;
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function onGitHeadChange(broadcastFn: () => void): void {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    invalidateGitCache();
    broadcastFn();
  }, 200);
}

export function syncGitWatchers(sessions: SessionData[], broadcastFn: () => void): void {
  const currentDirs = new Set<string>();
  for (const s of sessions) {
    if (s.dir) currentDirs.add(s.dir);
  }

  for (const [dir, watcher] of gitHeadWatchers) {
    if (!currentDirs.has(dir)) {
      watcher.close();
      gitHeadWatchers.delete(dir);
    }
  }

  for (const dir of currentDirs) {
    if (gitHeadWatchers.has(dir)) continue;
    const headPath = resolveGitHeadPath(dir);
    if (!headPath) continue;
    try {
      const watcher = watch(headPath, () => onGitHeadChange(broadcastFn));
      gitHeadWatchers.set(dir, watcher);
    } catch {
      /* ignore */
    }
  }
}

export function teardownGitWatchers(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  for (const watcher of gitHeadWatchers.values()) watcher.close();
  gitHeadWatchers.clear();
}
