#!/usr/bin/env bun
/**
 * Builds a consumer-safe npm tarball into ./dist-pack.
 *
 * Two root-only workspace concerns make `@towles/tool` impossible to install
 * outside this monorepo, and both must be resolved at pack time:
 *
 *   1. `@towles/shared` — never published to npm. As `workspace:*` it fails with
 *      `@towles/shared@workspace:* failed to resolve`; rewritten to a concrete
 *      `0.1.0` it fails with a registry 404. bun ignores `bundledDependencies`
 *      when resolving a *declared* dependency, so we drop `@towles/shared` from
 *      `dependencies` entirely. `bundledDependencies` still ships the package
 *      (53 files) into the tarball's nested `node_modules/@towles/shared`, where
 *      the runtime `import "@towles/shared"` resolves. See issue #257.
 *
 *   2. `patchedDependencies` — a workspace-root-only field. Left in the
 *      published manifest, every consumer install fails with
 *      `Couldn't find patch file: 'patches/prompts.patch'`, because bun resolves
 *      the patch path relative to the consumer's project root, where it doesn't
 *      exist (and root patches don't apply to installed dependencies anyway).
 *      We strip it from the tarball manifest while keeping it for local dev.
 *
 * Both edits are made to a throwaway copy of the manifest; the original (with
 * `workspace:*` and the prompts patch intact) is always restored afterward.
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

delete pkg.dependencies["@towles/shared"];
delete pkg.patchedDependencies;

try {
  // Write the publish-only manifest, pack it, then always restore the original
  // so the repo (and local dev's prompts patch) is left untouched.
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
