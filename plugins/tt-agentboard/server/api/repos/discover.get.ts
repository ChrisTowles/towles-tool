import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { db } from "~~/server/shared/db";
import { repositories } from "~~/server/shared/db/schema";
import { readConfig } from "~~/server/utils/config";

interface DiscoveredRepo {
  path: string;
  name: string;
  org: string | null;
  githubUrl: string | null;
  alreadyRegistered: boolean;
}

function parseGitRemote(repoPath: string): {
  org: string | null;
  name: string;
  githubUrl: string | null;
} {
  try {
    const url = execSync("git remote get-url origin", {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 3000,
    }).trim();

    const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (match) {
      return {
        org: match[1],
        name: match[2],
        githubUrl: `https://github.com/${match[1]}/${match[2]}`,
      };
    }
    return { org: null, name: basename(repoPath), githubUrl: null };
  } catch {
    return { org: null, name: basename(repoPath), githubUrl: null };
  }
}

function findRepoDirs(dir: string): string[] {
  const repos: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return repos;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === ".git") {
      repos.push(dir);
      return repos; // don't recurse into a git repo
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith("."))
      continue;
    repos.push(...findRepoDirs(join(dir, entry.name)));
  }
  return repos;
}

function discoverRepos(scanPaths: string[]): DiscoveredRepo[] {
  return scanPaths.flatMap((scanPath) => {
    if (!existsSync(scanPath)) return [];
    return findRepoDirs(scanPath).map((repoPath) => {
      const remote = parseGitRemote(repoPath);
      return {
        path: repoPath,
        name: remote.name,
        org: remote.org,
        githubUrl: remote.githubUrl,
        alreadyRegistered: false,
      };
    });
  });
}

export default defineEventHandler(async () => {
  const config = readConfig();
  const scanPaths = config.repoPaths;

  if (scanPaths.length === 0) {
    return { repos: [], scanPaths: [] };
  }

  const allRepos = discoverRepos(scanPaths);

  // Deduplicate by path
  const seen = new Set<string>();
  const uniqueRepos = allRepos.filter((r) => {
    if (seen.has(r.path)) return false;
    seen.add(r.path);
    return true;
  });

  // Check which repos are already registered
  const existingRepos = await db.select().from(repositories);
  const registeredNames = new Set(
    existingRepos.map((r) => (r.org ? `${r.org}/${r.name}` : r.name)),
  );

  for (const repo of uniqueRepos) {
    const key = repo.org ? `${repo.org}/${repo.name}` : repo.name;
    repo.alreadyRegistered = registeredNames.has(key);
  }

  return { repos: uniqueRepos, scanPaths };
});
