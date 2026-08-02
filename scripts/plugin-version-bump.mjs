// Auto-bumps a Claude Code plugin's `.claude-plugin/plugin.json` patch version
// whenever a commit touches that plugin's directory, unless the manifest version
// was already hand-edited in the same commit. Invoked by `.githooks/pre-commit`,
// wired up by the root "prepare" script running `git config core.hooksPath`.
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

/**
 * @param {string} version
 * @returns {Result<string, BadVersion>}
 */
export function nextPatchVersion(version) {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) {
    return Result.err(new BadVersion({ version }));
  }
  return Result.ok([parts[0], parts[1], Number(parts[2]) + 1].join("."));
}

/**
 * Pure aside from the injected reader, so it's testable without a real git repo.
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
 * `null` when the file is absent at that ref or unparseable — both mean "no
 * committed version to compare".
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

/**
 * A malformed version or an unrewritable manifest aborts the commit rather than
 * letting it land with a stale version.
 * @returns {Result<void, BadVersion | VersionLineMissing>}
 */
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
