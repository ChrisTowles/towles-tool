// Auto-bumps a plugin's `.claude-plugin/plugin.json` patch version when a commit touches its
// directory, unless the manifest version was hand-edited in the same commit. Run by
// `.githooks/pre-commit` (wired by the root "prepare" script).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { Result } from "better-result";
import { BadVersion, VersionLineMissing } from "./errors.mjs";

/** @typedef {{ dir: string; manifest: string }} Plugin */

/** @type {Plugin[]} */
export const PLUGINS = [
  { dir: "packages/core", manifest: "packages/core/.claude-plugin/plugin.json" },
  { dir: "packages/app", manifest: "packages/app/.claude-plugin/plugin.json" },
];

/** @param {string} version @returns {Result<string, BadVersion>} */
export function nextPatchVersion(version) {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) {
    return Result.err(new BadVersion({ version }));
  }
  return Result.ok([parts[0], parts[1], Number(parts[2]) + 1].join("."));
}

/**
 * @param {string[]} stagedFiles
 * @param {Plugin[]} plugins
 * @param {(manifest: string) => { head: string | null; index: string | null }} readVersions */
export function manifestsToBump(stagedFiles, plugins, readVersions) {
  return plugins.filter((p) => {
    const touched = stagedFiles.some((f) => f === p.manifest || f.startsWith(`${p.dir}/`));
    if (!touched) return false;
    const { head, index } = readVersions(p.manifest);
    return head !== null && head === index;
  });
}

/**
 * @param {string} manifestContents
 * @param {string} from
 * @param {string} to
 * @returns {Result<string, VersionLineMissing>} */
export function withBumpedVersion(manifestContents, from, to) {
  const needle = `"version": "${from}"`;
  if (!manifestContents.includes(needle)) {
    return Result.err(new VersionLineMissing({ needle }));
  }
  return Result.ok(manifestContents.replace(needle, `"version": "${to}"`));
}

/** @param {string[]} args */
function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

/**
 * @param {string} ref
 * @param {string} manifest */
function manifestVersionAt(ref, manifest) {
  try {
    return JSON.parse(git(["show", `${ref}:${manifest}`])).version ?? null;
  } catch {
    return null;
  }
}

function stagedFiles() {
  return git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
    .split("\n")
    .filter(Boolean);
}

/** @returns {Result<void, BadVersion | VersionLineMissing>} */
export function runPreCommitBump() {
  const toBump = manifestsToBump(stagedFiles(), PLUGINS, (manifest) => ({
    head: manifestVersionAt("HEAD", manifest),
    index: manifestVersionAt("", manifest),
  }));

  for (const { manifest } of toBump) {
    const contents = readFileSync(manifest, "utf8");
    const from = String(JSON.parse(contents).version);
    const bumped = nextPatchVersion(from);
    if (bumped.isErr()) return Result.err(bumped.error);
    const to = bumped.value;
    const rewritten = withBumpedVersion(contents, from, to);
    if (rewritten.isErr()) return Result.err(rewritten.error);
    writeFileSync(manifest, rewritten.value);
    git(["add", manifest]);
    console.log(`plugin-version-bump: ${manifest} ${from} -> ${to}`);
  }
  return Result.ok(undefined);
}
