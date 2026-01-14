#!/usr/bin/env tsx
/**
 * Syncs version from package.json to all plugin.json files
 * Run via: pnpm tsx scripts/sync-versions.ts
 */

import { join } from "node:path";
import { readdir, readFile, writeFile, access } from "node:fs/promises";

const ROOT = join(import.meta.dirname, "..");
const PLUGINS_DIR = join(ROOT, "plugins");

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  // Read version from package.json
  const pkgPath = join(ROOT, "package.json");
  const pkgJson = JSON.parse(await readFile(pkgPath, "utf-8"));
  const version = pkgJson.version;
  console.log(`Package version: ${version}`);

  // Find all plugin directories
  const entries = await readdir(PLUGINS_DIR, { withFileTypes: true });
  const pluginDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  for (const pluginName of pluginDirs) {
    const pluginJsonPath = join(PLUGINS_DIR, pluginName, ".claude-plugin", "plugin.json");

    if (!(await fileExists(pluginJsonPath))) {
      console.log(`  Skipping ${pluginName} (no plugin.json)`);
      continue;
    }

    const pluginJson = JSON.parse(await readFile(pluginJsonPath, "utf-8"));
    const oldVersion = pluginJson.version;

    if (oldVersion === version) {
      console.log(`  ${pluginName}: already at ${version}`);
      continue;
    }

    pluginJson.version = version;
    await writeFile(pluginJsonPath, JSON.stringify(pluginJson, null, 4) + "\n");
    console.log(`  ${pluginName}: ${oldVersion} -> ${version}`);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error("Failed to sync versions:", err);
  process.exit(1);
});
