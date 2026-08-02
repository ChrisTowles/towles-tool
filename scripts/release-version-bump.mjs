#!/usr/bin/env node
// Bumps the app's release version across every file that carries it, then syncs
// both lockfiles. The version that matters is the *app's* — bump it before
// tagging, release.yml won't do it for you. The independent `0.1.0`s on the
// library crates under `crates/` are internal and deliberately left alone.
// Nothing is staged, committed or tagged here; review the diff, then do that.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Result } from "better-result";
import { BadVersion, VersionLineMissing } from "./errors.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @typedef {{ path: string; format: "json" | "toml" }} VersionFile */

/** @type {VersionFile[]} */
export const VERSION_FILES = [
  { path: "package.json", format: "json" },
  { path: "apps/client/package.json", format: "json" },
  { path: "crates-tauri/tt-app/tauri.conf.json", format: "json" },
  { path: "crates-tauri/tt-app/Cargo.toml", format: "toml" },
];

/**
 * @param {string} version
 * @returns {Result<[number, number, number], BadVersion>}
 */
export function parseVersion(version) {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    return Result.err(new BadVersion({ version }));
  }
  return Result.ok(/** @type {[number, number, number]} */ (parts));
}

/**
 * Resolves `major`/`minor`/`patch`, or an explicit `x.y.z`, against `current`.
 * @param {string} current
 * @param {string} arg
 * @returns {Result<string, BadVersion>} */
export function resolveNewVersion(current, arg) {
  const parsed = parseVersion(current);
  if (parsed.isErr()) return parsed;
  const [major, minor, patch] = parsed.value;
  switch (arg) {
    case "major":
      return Result.ok(`${major + 1}.0.0`);
    case "minor":
      return Result.ok(`${major}.${minor + 1}.0`);
    case "patch":
      return Result.ok(`${major}.${minor}.${patch + 1}`);
    default:
      return parseVersion(arg).map(() => arg);
  }
}

/**
 * @param {VersionFile["format"]} format
 * @param {string} version
 * @returns {string}
 */
function needle(format, version) {
  return format === "toml" ? `version = "${version}"` : `"version": "${version}"`;
}

/** @param {string} contents
 * @param {VersionFile["format"]} format
 * @param {string} from
 * @param {string} to
 * @returns {Result<string, VersionLineMissing>} */
export function withBumpedVersion(contents, format, from, to) {
  const from_ = needle(format, from);
  const index = contents.indexOf(from_);
  if (index === -1) return Result.err(new VersionLineMissing({ needle: from_ }));
  return Result.ok(
    contents.slice(0, index) + needle(format, to) + contents.slice(index + from_.length),
  );
}

/**
 * @param {string[]} args
 * @param {string} cwd
 */
function run(args, cwd) {
  console.log(`[release-version-bump] $ ${args.join(" ")}`);
  execFileSync(args[0], args.slice(1), { cwd, stdio: "inherit" });
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: node scripts/release-version-bump.mjs <major|minor|patch|x.y.z>");
    process.exit(1);
  }

  const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const from = rootPkg.version;
  const resolved = resolveNewVersion(from, arg);
  if (resolved.isErr()) {
    console.error(`[release-version-bump] ${resolved.error.message}`);
    process.exit(1);
  }
  const to = resolved.value;

  for (const file of VERSION_FILES) {
    const abs = path.join(repoRoot, file.path);
    const contents = readFileSync(abs, "utf8");
    const rewritten = withBumpedVersion(contents, file.format, from, to);
    if (rewritten.isErr()) {
      console.error(`[release-version-bump] ${file.path}: ${rewritten.error.message}`);
      process.exit(1);
    }
    writeFileSync(abs, rewritten.value);
    console.log(`[release-version-bump] ${file.path}: ${from} -> ${to}`);
  }

  // `cargo check` updates Cargo.lock's `tt-app` entry without a full build;
  // `--package-lock-only` does the same without touching node_modules.
  run(["cargo", "check", "-p", "tt-app", "--quiet"], repoRoot);
  run(["npm", "install", "--package-lock-only", "--silent"], repoRoot);

  console.log(`\n[release-version-bump] done: ${from} -> ${to}. Review the diff, then:`);
  console.log(`  git add -A && git commit -m "chore(release): bump version to ${to}"`);
  console.log(`  git tag v${to} && git push origin v${to}`);
}

// Only when invoked directly, not when imported by the test file.
if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? "")) {
  main();
}
