#!/usr/bin/env bun
/**
 * Creates dist/plugins.zip from plugins/
 * Run via: bun run scripts/zip-plugin.ts
 */

import { $ } from "bun";
import { join } from "node:path";
import { mkdir, readdir, stat } from "node:fs/promises";

const ROOT = join(import.meta.dirname, "..");
const PLUGINS_DIR = join(ROOT, "plugins");
const DIST_DIR = join(ROOT, "dist");
const OUTPUT_ZIP = join(DIST_DIR, "plugins.zip");

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

  // Check plugins dir exists
  const pluginsStat = await stat(PLUGINS_DIR).catch(() => null);
  if (!pluginsStat?.isDirectory()) {
    console.error(`Plugins directory not found: ${PLUGINS_DIR}`);
    process.exit(1);
  }

  // Get all files
  const files = await getAllFiles(PLUGINS_DIR);
  console.log(`Found ${files.length} files in plugins/`);

  // Create zip using Bun shell (leverages system zip)
  // Change to plugins dir and zip contents
  // Extraction preserves folder structure (tt-core/, notifications/, etc.)
  await $`cd ${PLUGINS_DIR} && zip -r ${OUTPUT_ZIP} . -x "*.DS_Store"`.quiet();

  const zipStat = await stat(OUTPUT_ZIP);
  console.log(`Created: ${OUTPUT_ZIP} (${(zipStat.size / 1024).toFixed(1)} KB)`);
}

main().catch((err) => {
  console.error("Failed to create zip:", err);
  process.exit(1);
});
