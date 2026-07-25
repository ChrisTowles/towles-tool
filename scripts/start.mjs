#!/usr/bin/env node
// Builds tt-app in release mode (optimized, no `cargo build --debug`
// slowness) and runs the resulting binary directly — no installer bundling.
// Debug builds (`npm run dev`) are fine for iterating, but their unoptimized
// terminal rendering + IPC path is visibly laggy under everyday use (scroll,
// typing) once several worktree tasks + agent sessions are running at once.
// This is the "just run it fast" counterpart to `npm run dev` — `npm start`.
import { spawn, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SpawnFailed } from "./errors.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const isMac = process.platform === "darwin";

// macOS reads an app's name and icon from the Info.plist of the `.app` its
// executable sits in; a bare binary has neither, so the Dock shows the generic
// Unix-executable icon (the one with "exec" written on it). Building the `app`
// bundle target is only a copy of the same release binary plus resources — no
// dmg, no installer — and launching the executable *inside* the bundle keeps
// stdio inherited while giving the process a real bundle identity. Other
// platforms don't care, so they skip bundling entirely.
const bundleArgs = isMac ? ["--bundles", "app"] : ["--no-bundle"];

const build = spawnSync(
  "tauri",
  ["build", ...bundleArgs],
  { stdio: "inherit", cwd: repoRoot, shell: process.platform === "win32" },
);
// A build that ran and failed already printed why; one that never launched
// (no `tauri` on PATH) would otherwise exit 1 with nothing on screen.
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
 * Path to the executable inside the bundle the macOS `app` target just wrote.
 * Both the `.app` and the executable it holds are named after `productName`,
 * which lives in tauri.conf.json rather than here — read them off disk instead
 * of restating the name and drifting from it.
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
