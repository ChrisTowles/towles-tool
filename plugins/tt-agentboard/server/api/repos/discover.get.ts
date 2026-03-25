import { execSync } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { consola } from "consola";
import { db } from "~~/server/db";
import { repositories } from "~~/server/db/schema";
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

function discoverReposInDir(parentDir: string): DiscoveredRepo[] {
  const repos: DiscoveredRepo[] = [];
  if (!existsSync(parentDir)) return repos;

  try {
    const entries = readdirSync(parentDir);
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const fullPath = join(parentDir, entry);
      try {
        const stat = statSync(fullPath);
        if (!stat.isDirectory()) continue;
        const gitDir = join(fullPath, ".git");
        if (!existsSync(gitDir)) continue;

        const remote = parseGitRemote(fullPath);
        repos.push({
          path: fullPath,
          name: remote.name,
          org: remote.org,
          githubUrl: remote.githubUrl,
          alreadyRegistered: false,
        });
      } catch {
        // Skip inaccessible dirs
      }
    }
  } catch {
    consola.warn(`Could not scan directory: ${parentDir}`);
  }
  return repos;
}

export default defineEventHandler(async () => {
  const config = readConfig();
  const scanPaths = config.repoPaths;

  if (scanPaths.length === 0) {
    return { repos: [], scanPaths: [] };
  }

  // Discover repos in each scan path (one level deep)
  const allRepos: DiscoveredRepo[] = [];
  for (const scanPath of scanPaths) {
    const found = discoverReposInDir(scanPath);
    allRepos.push(...found);
  }

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
