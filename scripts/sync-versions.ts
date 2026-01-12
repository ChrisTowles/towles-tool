#!/usr/bin/env bun
/**
 * Syncs version from package.json to all plugin.json files
 * Run via: bun run scripts/sync-versions.ts
 */

import { join } from "node:path";
import { readdir } from "node:fs/promises";

const ROOT = join(import.meta.dirname, "..");
const PLUGINS_DIR = join(ROOT, "plugins");

async function main() {
  // Read version from package.json
  const pkgPath = join(ROOT, "package.json");
  const pkgJson = await Bun.file(pkgPath).json();
  const version = pkgJson.version;
  console.log(`Package version: ${version}`);

  // Find all plugin directories
  const entries = await readdir(PLUGINS_DIR, { withFileTypes: true });
  const pluginDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  for (const pluginName of pluginDirs) {
    const pluginJsonPath = join(PLUGINS_DIR, pluginName, ".claude-plugin", "plugin.json");
    const file = Bun.file(pluginJsonPath);

    if (!(await file.exists())) {
      console.log(`  Skipping ${pluginName} (no plugin.json)`);
      continue;
    }

    const pluginJson = await file.json();
    const oldVersion = pluginJson.version;

    if (oldVersion === version) {
      console.log(`  ${pluginName}: already at ${version}`);
      continue;
    }

    pluginJson.version = version;
    await Bun.write(pluginJsonPath, JSON.stringify(pluginJson, null, 4) + "\n");
    console.log(`  ${pluginName}: ${oldVersion} -> ${version}`);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error("Failed to sync versions:", err);
  process.exit(1);
});
