#!/usr/bin/env bun
/**
 * Builds a consumer-safe npm tarball into ./dist-pack.
 *
 * `patchedDependencies` is a workspace-root-only field. Left in the published
 * manifest, every external install fails with
 * `Couldn't find patch file: 'patches/prompts.patch'`, because the installer
 * resolves the patch path relative to the consumer's project root, where it
 * doesn't exist (and root patches don't apply to installed dependencies
 * anyway). We strip it from a throwaway copy of the manifest, pack, then always
 * restore the original so the prompts patch stays intact for local dev.
 *
 * (Issue #257: the CLI also used to depend on the unpublished `@towles/shared`
 * workspace package, which made external installs impossible. That package is
 * now inlined under src/lib, so there is no `@towles/*` dependency to resolve.)
 *
 * Run via: bun run scripts/pack-publish.ts
 */

import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

const ROOT = join(import.meta.dirname, "..");
const PKG_PATH = join(ROOT, "package.json");
const DEST = join(ROOT, "dist-pack");

const original = await readFile(PKG_PATH, "utf-8");
const pkg = JSON.parse(original);

delete pkg.patchedDependencies;

try {
  await writeFile(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");

  const proc = Bun.spawn(["bun", "pm", "pack", "--ignore-scripts", "--destination", DEST], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`bun pm pack exited with code ${code}`);
  }
} finally {
  await writeFile(PKG_PATH, original);
}
