#!/usr/bin/env bun
/**
 * Creates dist/tt-core.zip from plugins/tt-core/
 * Run via: bun run scripts/zip-plugin.ts
 */

import { $ } from "bun";
import { join } from "node:path";
import { mkdir, readdir, stat } from "node:fs/promises";

const ROOT = join(import.meta.dirname, "..");
const PLUGIN_DIR = join(ROOT, "plugins/tt-core");
const DIST_DIR = join(ROOT, "dist");
const OUTPUT_ZIP = join(DIST_DIR, "tt-core.zip");

async function getAllFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await getAllFiles(fullPath)));
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

async function main() {
  // Ensure dist dir exists
  await mkdir(DIST_DIR, { recursive: true });

  // Check plugin dir exists
  const pluginStat = await stat(PLUGIN_DIR).catch(() => null);
  if (!pluginStat?.isDirectory()) {
    console.error(`Plugin directory not found: ${PLUGIN_DIR}`);
    process.exit(1);
  }

  // Get all files
  const files = await getAllFiles(PLUGIN_DIR);
  console.log(`Found ${files.length} files in plugins/tt-core/`);

  // Create zip using Bun shell (leverages system zip)
  // Change to plugin dir and zip contents (not the folder itself)
  // This way extraction creates files directly in destDir, not destDir/tt-core/
  await $`cd ${PLUGIN_DIR} && zip -r ${OUTPUT_ZIP} . -x "*.DS_Store"`.quiet();

  const zipStat = await stat(OUTPUT_ZIP);
  console.log(`Created: ${OUTPUT_ZIP} (${(zipStat.size / 1024).toFixed(1)} KB)`);
}

main().catch((err) => {
  console.error("Failed to create zip:", err);
  process.exit(1);
});
