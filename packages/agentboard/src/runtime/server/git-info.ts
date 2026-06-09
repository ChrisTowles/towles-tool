import { existsSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";
import consola from "consola";
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
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  /** Positive = ahead of origin/main, negative = behind */
  commitsDelta: number;
}

const gitInfoCache = new Map<string, { info: GitInfo; ts: number }>();
const GIT_CACHE_TTL_MS = 5000;

export function getGitInfo(dir: string): GitInfo {
  const empty: GitInfo = {
    branch: "",
    dirty: false,
    isWorktree: false,
    filesChanged: 0,
    linesAdded: 0,
    linesRemoved: 0,
    commitsDelta: 0,
  };
  if (!dir) return empty;

  const cached = gitInfoCache.get(dir);
  if (cached && Date.now() - cached.ts < GIT_CACHE_TTL_MS) return cached.info;

  const branch = shell(["git", "-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch) return empty;
  const gitDir = shell(["git", "-C", dir, "rev-parse", "--git-dir"]);
  const statusOut = shell(["git", "-C", dir, "status", "--porcelain"]);

  // Uncommitted diff stats (unstaged + staged)
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const cmd of [
    ["git", "-C", dir, "diff", "--numstat"],
    ["git", "-C", dir, "diff", "--cached", "--numstat"],
  ]) {
    const out = shell(cmd);
    if (!out) continue;
    for (const line of out.split("\n")) {
      const [added, removed] = line.split("\t");
      if (added === "-" || removed === "-") continue; // binary
      linesAdded += Number(added) || 0;
      linesRemoved += Number(removed) || 0;
    }
  }

  // Commits ahead/behind origin/main
  // Commits ahead(+) or behind(-) origin/main
  let commitsDelta = 0;
  const originMain = shell(["git", "-C", dir, "rev-parse", "--verify", "origin/main"])
    ? "origin/main"
    : "origin/master";
  const aheadBehind = shell([
    "git",
    "-C",
    dir,
    "rev-list",
    "--left-right",
    "--count",
    `${originMain}...HEAD`,
  ]);
  if (aheadBehind) {
    const [behind, ahead] = aheadBehind.split("\t");
    commitsDelta = (Number(ahead) || 0) - (Number(behind) || 0);
  }

  const filesChanged = statusOut ? statusOut.split("\n").filter(Boolean).length : 0;

  const info: GitInfo = {
    branch,
    dirty: statusOut.length > 0,
    isWorktree: gitDir.includes("/worktrees/"),
    filesChanged,
    linesAdded,
    linesRemoved,
    commitsDelta,
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
    } catch (err) {
      consola.debug(`Failed to watch git HEAD at ${headPath}:`, err);
    }
  }
}

export function teardownGitWatchers(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  for (const watcher of gitHeadWatchers.values()) watcher.close();
  gitHeadWatchers.clear();
}
