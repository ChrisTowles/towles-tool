#!/usr/bin/env node
// Builds tt-app in release mode and runs the binary directly, no installer bundling: debug
// builds (`bun run dev`) are visibly laggy with several tasks running.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Result } from "better-result";
import { SpawnFailed } from "./errors.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const isMac = process.platform === "darwin";

// macOS takes an app's name and icon from the Info.plist of its `.app`, so the `app` bundle
// target is built and launched from inside (stdio stays inherited). Other platforms skip it.
// A from-source build never self-updates, so it skips the signed updater artifacts (whose key only CI holds).
const bundleArgs = isMac
  ? ["--bundles", "app", "--config", JSON.stringify({ bundle: { createUpdaterArtifacts: false } })]
  : ["--no-bundle"];

// One `tt` on PATH serves every checkout, so it drifts to whichever worktree installed it last.
// Built and copied in rather than `cargo install`ed, which refreshes the crates.io index (~8s)
// even when nothing compiles; its own target dir because sharing thrashes both.
const ttTarget = path.join("target", "tt-cli");
const ttBuild = spawnSync(
  "cargo",
  ["build", "--release", "--locked", "-p", "tt-cli", "--target-dir", ttTarget],
  { stdio: "inherit", cwd: repoRoot, shell: process.platform === "win32" },
);
const ttInstalled =
  !ttBuild.error && ttBuild.status === 0 && installTt(path.join(repoRoot, ttTarget, "release"));
// A `tt` that won't build is no reason to withhold the app — but say so, since
// the hooks that need it fail far from here.
if (!ttInstalled) {
  console.error("[start] could not install tt — the `tt` on PATH may be stale");
}

/**
 * Copies the built `tt` into cargo's install bin dir. Renamed into place, never overwritten,
 * so a running `tt` and macOS's per-inode code-signature cache stay valid.
 * @param {string} releaseDir
 * @returns {boolean}
 */
function installTt(releaseDir) {
  const exe = process.platform === "win32" ? "tt.exe" : "tt";
  const root =
    process.env.CARGO_INSTALL_ROOT ?? process.env.CARGO_HOME ?? path.join(homedir(), ".cargo");
  const dest = path.join(root, "bin", exe);
  const staged = `${dest}.${process.pid}.tmp`;
  const copied = Result.try(() => {
    copyFileSync(path.join(releaseDir, exe), staged);
    renameSync(staged, dest);
  });
  if (copied.isErr()) {
    rmSync(staged, { force: true });
    console.error(`[start] ${String(copied.error.cause)}`);
    return false;
  }
  console.error(`[start] installed ${dest}`);
  return true;
}

const build = spawnSync(
  "tauri",
  ["build", ...bundleArgs],
  { stdio: "inherit", cwd: repoRoot, shell: process.platform === "win32" },
);
if (build.error) {
  console.error(`[start] ${new SpawnFailed({ command: "tauri", cause: build.error }).message}`);
  process.exit(1);
}
if (build.status !== 0) process.exit(build.status ?? 1);

const bin = isMac ? macAppBinary() : path.join(
  repoRoot,
  "target",
  "release",
  process.platform === "win32" ? "tt-app.exe" : "tt-app",
);

/**
 * @returns {string}
 */
function macAppBinary() {
  const bundleDir = path.join(repoRoot, "target", "release", "bundle", "macos");
  const app = entries(bundleDir).find((e) => e.endsWith(".app"));
  if (!app) {
    console.error(`[start] no .app in ${bundleDir} — did the bundle step run?`);
    process.exit(1);
  }
  const macosDir = path.join(bundleDir, app, "Contents", "MacOS");
  const exe = entries(macosDir)[0];
  if (!exe) {
    console.error(`[start] ${app} has no executable in Contents/MacOS`);
    process.exit(1);
  }
  return path.join(macosDir, exe);
}

/**
 * @param {string} dir
 * @returns {string[]} sorted for a stable pick; empty when the dir is absent
 */
function entries(dir) {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

const child = spawn(bin, { stdio: "inherit", cwd: repoRoot });
child.on("exit", (code) => process.exit(code ?? 0));
